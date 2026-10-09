//go:build darwin

package main

/*
#cgo CFLAGS: -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Cocoa -framework QuartzCore -framework OpenGL -framework WebKit
#include <stdlib.h>
#include "video.h"

const char *spike_video_info(void);
int spike_video_draw_thread(void);
void spike_debug_counters(long *u, long *d, long *c, long *w);
int spike_window_state(void *win);
const char *spike_video_webview_note(void);
int spike_view_order(void);
void spike_screen_edr(void *win, double *cur, double *potential, double *reference);
const char *spike_inject_click(void *win, double x, double y);
void spike_inject_key(void *win, const char *chars, unsigned short code);
*/
import "C"

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Modes on macOS: "gl" (CAOpenGLLayer under the WKWebView) and "sw"
// (software render API, frames shown as the layer's contents).
func renderMode(mode string) (int, error) {
	switch mode {
	case "gl":
		return C.SPIKE_MODE_GL, nil
	case "sw":
		return C.SPIKE_MODE_SW, nil
	}
	return 0, fmt.Errorf("mode %q is not supported on macOS (use gl or sw)", mode)
}

// hdrMode reads SPIKE_HDR: "pq" (BT.2100 PQ layer) or "linear" (extended
// linear Display P3 layer), with matching mpv target options.
func hdrMode() (int, [][2]string) {
	switch os.Getenv("SPIKE_HDR") {
	case "pq":
		return 1, [][2]string{{"target-trc", "pq"}, {"target-prim", "bt.2020"}}
	case "linear":
		return 2, [][2]string{{"target-trc", "linear"}, {"target-prim", "display-p3"}, {"target-peak", "600"}}
	}
	return 0, nil
}

func makeTransparent(*application.WebviewWindow) {}

func fixLocale() map[string]any { return nil }

// attachVideo inserts the video view under the webview and creates the render
// context. It runs on the main thread, after mpv_initialize and before the
// first loadfile.
func attachVideo(p *Player, m *mpv, mode int, hdr int) error {
	return application.InvokeSyncWithResult(func() error {
		var buf [256]C.char
		if C.spike_video_attach(p.window.NativeWindow(), m.handle(), C.int(mode), C.int(hdr), &buf[0], C.int(len(buf))) != 0 {
			return fmt.Errorf("attach: %s", C.GoString(&buf[0]))
		}
		return nil
	})
}

func detachVideo() { application.InvokeSync(func() { C.spike_video_detach() }) }

func videoInfo(p *Player) map[string]any {
	out := map[string]any{"renderer": C.GoString(C.spike_video_info()), "webview": C.GoString(C.spike_video_webview_note())}
	application.InvokeSync(func() {
		out["videoViewDirectlyBelowWebview"] = C.spike_view_order() == 1
	})
	for k, v := range screenEDR(p) {
		out[k] = v
	}
	return out
}

func screenEDR(p *Player) map[string]any {
	var cur, pot, ref C.double
	application.InvokeSync(func() { C.spike_screen_edr(p.window.NativeWindow(), &cur, &pot, &ref) })
	return map[string]any{"edrCurrent": float64(cur), "edrPotential": float64(pot), "edrReference": float64(ref)}
}

// --- process accounting -----------------------------------------------------

func rssMB() float64 {
	var ru syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return float64(ru.Maxrss) / (1 << 20) // bytes on macOS; this is the peak
}

// systemProcs are the processes whose CPU time the bench attributes to us
// besides our own: the window server (compositing) and the WebKit helpers
// that appeared after we started (WebContent, GPU, Networking are XPC
// services, not our children).
func systemProcs(before map[int]string) map[string][]int {
	out := map[string][]int{}
	for pid, comm := range listProcs() {
		switch {
		case strings.HasSuffix(comm, "/WindowServer"):
			out["WindowServer"] = append(out["WindowServer"], pid)
		case strings.Contains(comm, "com.apple.WebKit."):
			if _, old := before[pid]; !old {
				name := comm[strings.LastIndex(comm, "com.apple.WebKit.")+len("com.apple.WebKit."):]
				out["WebKit."+name] = append(out["WebKit."+name], pid)
			}
		}
	}
	return out
}

func listProcs() map[int]string {
	out := map[int]string{}
	b, err := exec.Command("ps", "-axo", "pid=,comm=").Output()
	if err != nil {
		return out
	}
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		out[pid] = strings.Join(f[1:], " ")
	}
	return out
}

// procCPU returns user+system CPU seconds for each pid, via ps (proc_pidinfo
// can't read root processes such as WindowServer; ps can).
func procCPU(pids []int) map[int]float64 {
	out := map[int]float64{}
	if len(pids) == 0 {
		return out
	}
	args := []string{"-o", "pid=,time="}
	for _, p := range pids {
		args = append(args, "-p", strconv.Itoa(p))
	}
	b, _ := exec.Command("ps", args...).Output()
	for _, line := range strings.Split(string(b), "\n") {
		f := strings.Fields(line)
		if len(f) != 2 {
			continue
		}
		pid, _ := strconv.Atoi(f[0])
		out[pid] = parsePSTime(f[1])
	}
	return out
}

// parsePSTime parses ps's [[dd-]hh:]mm:ss.cc.
func parsePSTime(s string) float64 {
	secs := 0.0
	for _, part := range strings.Split(s, ":") {
		v, _ := strconv.ParseFloat(part, 64)
		secs = secs*60 + v
	}
	return secs
}

func selfCPU() float64 {
	var ru syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return tv(ru.Utime) + tv(ru.Stime)
}

func tv(t syscall.Timeval) float64 { return float64(t.Sec) + float64(t.Usec)/1e6 }

// gpuUtil samples the GPU's "Device Utilization %" from IORegistry (whole
// GPU, all processes; no root needed).
func gpuUtil() (float64, bool) {
	b, err := exec.Command("ioreg", "-r", "-d", "1", "-w", "0", "-c", "IOAccelerator").Output()
	if err != nil {
		return 0, false
	}
	s := string(b)
	i := strings.Index(s, `"Device Utilization %"=`)
	if i < 0 {
		return 0, false
	}
	s = s[i+len(`"Device Utilization %"=`):]
	j := strings.IndexFunc(s, func(r rune) bool { return r < '0' || r > '9' })
	v, err := strconv.Atoi(s[:j])
	return float64(v), err == nil
}

type nativeTarget struct {
	WID  int64
	Kind string
	Host string
	Note string
}

// widTarget: macOS has no wid embedding in mpv 0.41 (see #2), so every mode
// here uses the render API.
func widTarget(*Player) nativeTarget { return nativeTarget{WID: -1} }

func inspectVideo(p *Player, _ nativeTarget) map[string]any {
	out := videoInfo(p)
	out["drawThread"] = map[int]string{0: "none yet", 1: "main", 2: "other"}[int(C.spike_video_draw_thread())]
	fs := readFrameStats(false)
	out["renders"], out["target"] = fs.Renders, fmt.Sprintf("%dx%d", fs.W, fs.H)
	out["embedded"] = fs.Renders > 0 && out["videoViewDirectlyBelowWebview"] == true
	if out["embedded"] == true {
		out["verdict"] = "render API draws into our view below the WKWebView"
	} else {
		out["verdict"] = "no frames rendered into the video view"
	}
	return out
}

func procSnapshot() map[int]string { return listProcs() }

func attachOverlay(_, _ *application.WebviewWindow) {}

// The video view follows the webview through autoresizing.
func resizeVideoHost(*Player) {}

// injectInput clicks the probe, the play button (twice) and an empty area of
// the video, then presses "x", like the Linux/Windows runner scripts do from
// outside. It returns the view class each click hit-tested to.
func injectInput(p *Player) []string {
	var hits []string
	// probe (centre), play/pause (bottom-left) twice, empty video area
	for _, pt := range [][2]float64{{0.5, 0.5}, {34, -30}, {34, -30}, {0.78, 0.35}} {
		hits = append(hits, application.InvokeSyncWithResult(func() string {
			return C.GoString(C.spike_inject_click(p.window.NativeWindow(), C.double(pt[0]), C.double(pt[1])))
		}))
		time.Sleep(600 * time.Millisecond)
	}
	cs := C.CString("x")
	defer C.free(unsafe.Pointer(cs))
	application.InvokeSync(func() { C.spike_inject_key(p.window.NativeWindow(), cs, 7) })
	time.Sleep(400 * time.Millisecond)
	return hits
}

func debugCounters(p *Player) string {
	var u, d, c, w C.long
	C.spike_debug_counters(&u, &d, &c, &w)
	st := application.InvokeSyncWithResult(func() int { return int(C.spike_window_state(p.window.NativeWindow())) })
	return fmt.Sprintf("update_cb=%d dispatched=%d canDraw=%d draw=%d visible=%v active=%v key=%v", u, d, c, w, st&1 != 0, st&2 != 0, st&4 != 0)
}

// windowState reports whether the window is visible (not occluded), and
// whether the app is active and the window key.
func windowState(p *Player) map[string]bool {
	st := application.InvokeSyncWithResult(func() int { return int(C.spike_window_state(p.window.NativeWindow())) })
	return map[string]bool{"visible": st&1 != 0, "active": st&2 != 0, "key": st&4 != 0}
}
