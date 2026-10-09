//go:build linux

package main

/*
#cgo pkg-config: gtk4 x11 epoxy egl wayland-client wayland-egl
#cgo CFLAGS: -Wno-deprecated-declarations
#include <gtk/gtk.h>
#ifdef GDK_WINDOWING_X11
#include <gdk/x11/gdkx.h>
#endif
#ifdef GDK_WINDOWING_WAYLAND
#include <gdk/wayland/gdkwayland.h>
#endif
#include <X11/Xlib.h>
#include <locale.h>
#include <stdlib.h>
#include "video.h"

const char *spike_video_info(void);
void spike_video_layout(char *out, int n);
void spike_content_offset(void *win, int *x, int *y, int *shadow_x, int *shadow_y);

// --- from spikes/libmpv-cgo: the X11 wid baseline -------------------------

// backend: 1 = X11, 2 = Wayland, 0 = unknown.
static int surfaceBackend(void *win) {
	GdkSurface *s = gtk_native_get_surface(GTK_NATIVE(win));
	if (!s) return 0;
#ifdef GDK_WINDOWING_X11
	if (GDK_IS_X11_SURFACE(s)) return 1;
#endif
#ifdef GDK_WINDOWING_WAYLAND
	if (GDK_IS_WAYLAND_SURFACE(s)) return 2;
#endif
	return 0;
}

static unsigned long x11Xid(void *win) {
#ifdef GDK_WINDOWING_X11
	GdkSurface *s = gtk_native_get_surface(GTK_NATIVE(win));
	if (s && GDK_IS_X11_SURFACE(s)) return gdk_x11_surface_get_xid(s);
#endif
	return 0;
}

// Wails v3 beta.28's GTK4 setTransparent() is an empty stub (#2 gotcha 5).
static void makeTransparent(void *win) {
	static GtkCssProvider *provider = NULL;
	if (!provider) {
		provider = gtk_css_provider_new();
		gtk_css_provider_load_from_string(provider, "window.staysh-transparent { background: transparent; }");
		gtk_style_context_add_provider_for_display(gdk_display_get_default(),
			GTK_STYLE_PROVIDER(provider), GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
	}
	gtk_widget_add_css_class(GTK_WIDGET(win), "staysh-transparent");
}

static void setTransient(void *child, void *parent) {
	gtk_window_set_transient_for(GTK_WINDOW(child), GTK_WINDOW(parent));
}

static const char *numericLocale(void) { return setlocale(LC_NUMERIC, NULL); }
static void cNumericLocale(void) { setlocale(LC_NUMERIC, "C"); }

static int queryParent(unsigned long win, unsigned long *parent, int *x, int *y, unsigned *w, unsigned *h, int *mapped) {
	Display *d = XOpenDisplay(NULL);
	if (!d) return -1;
	Window root, par, *kids = NULL;
	unsigned int nkids = 0;
	if (!XQueryTree(d, (Window)win, &root, &par, &kids, &nkids)) { XCloseDisplay(d); return -2; }
	if (kids) XFree(kids);
	*parent = par;
	XWindowAttributes a;
	if (XGetWindowAttributes(d, (Window)win, &a)) {
		*x = a.x; *y = a.y; *w = a.width; *h = a.height; *mapped = a.map_state == IsViewable;
	}
	XCloseDisplay(d);
	return 0;
}

static const char *gskRenderer(void *win) {
	GskRenderer *r = gtk_native_get_renderer(GTK_NATIVE(win));
	return r ? G_OBJECT_TYPE_NAME(r) : "none";
}
*/
import "C"

import (
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Modes on Linux: "glarea", "gltex", "subsurface" (Wayland), "sw", and the #3
// baselines "wid" / "overlay" (X11), which don't use the render API.
func renderMode(mode string) (int, error) {
	switch mode {
	case "glarea":
		return C.SPIKE_MODE_GLAREA, nil
	case "subsurface":
		return C.SPIKE_MODE_SUBSURFACE, nil
	case "sw":
		return C.SPIKE_MODE_SW, nil
	case "gltex":
		return C.SPIKE_MODE_GLTEX, nil
	case "wid", "single", "overlay":
		return 0, nil
	}
	return 0, fmt.Errorf("mode %q is not supported on Linux", mode)
}

func hdrMode() (int, [][2]string) { return 0, nil }

func screenEDR(*Player) map[string]any { return nil }

func windowState(*Player) map[string]bool { return nil }

// injectInput: the runner script injects input from outside (xdotool /
// swaymsg + wtype). It only needs to know where the webview is.
func injectInput(p *Player) []string {
	var x, y, sx, sy C.int
	application.InvokeSync(func() { C.spike_content_offset(p.window.NativeWindow(), &x, &y, &sx, &sy) })
	fmt.Printf("SPIKE_WEBVIEW_ORIGIN %d %d %d %d\n", x, y, sx, sy)
	return nil
}

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
	out := map[string]any{"renderer": C.GoString(C.spike_video_info())}
	application.InvokeSync(func() {
		var buf [512]C.char
		C.spike_video_layout(&buf[0], C.int(len(buf)))
		out["layout"] = C.GoString(&buf[0])
		out["gskRenderer"] = C.GoString(C.gskRenderer(p.window.NativeWindow()))
		var x, y, sx, sy C.int
		C.spike_content_offset(p.window.NativeWindow(), &x, &y, &sx, &sy)
		out["webviewOrigin"] = fmt.Sprintf("%d,%d", x, y)
		out["csdShadow"] = fmt.Sprintf("%d,%d", sx, sy)
	})
	return out
}

type nativeTarget struct {
	WID  int64
	Kind string
	Host string
	Note string
}

func widTarget(p *Player) nativeTarget {
	type res struct {
		backend int
		xid     uint64
	}
	r := application.InvokeSyncWithResult(func() res {
		win := p.window.NativeWindow()
		return res{int(C.surfaceBackend(win)), uint64(C.x11Xid(win))}
	})
	switch r.backend {
	case 1:
		return nativeTarget{WID: int64(r.xid), Kind: "X11 Window", Host: "window", Note: "GdkX11Surface XID of the GTK4 toplevel"}
	case 2:
		return nativeTarget{WID: -1, Kind: "wl_surface", Host: "none", Note: "Wayland has no foreign-surface embedding; wid is not set"}
	}
	return nativeTarget{WID: -1, Kind: "unknown", Host: "none", Note: "GDK backend not detected"}
}

// fixLocale resets LC_NUMERIC to "C" after GTK's setlocale(LC_ALL, ""), or
// mpv_create refuses to run (#3 gotcha 1).
func fixLocale() map[string]any {
	return application.InvokeSyncWithResult(func() map[string]any {
		out := map[string]any{"lcNumericBefore": C.GoString(C.numericLocale())}
		C.cNumericLocale()
		out["lcNumericAfter"] = C.GoString(C.numericLocale())
		return out
	})
}

func inspectVideo(p *Player, target nativeTarget) map[string]any {
	if p.render != 0 {
		out := videoInfo(p)
		fs := readFrameStats(false)
		out["renders"], out["target"] = fs.Renders, fmt.Sprintf("%dx%d", fs.W, fs.H)
		out["embedded"] = fs.Renders > 0
		if fs.Renders > 0 {
			out["verdict"] = "render API draws below the webview, in the app window"
		} else {
			out["verdict"] = "no frames rendered: " + fs.Note
		}
		return out
	}
	out := map[string]any{"hostKind": target.Kind, "hostWid": target.WID}
	s, err := p.mpv.getString("window-id")
	mpvWin, perr := strconv.ParseInt(s, 10, 64)
	if err != nil || perr != nil {
		out["embedded"] = false
		out["verdict"] = "mpv exposes no X11 window-id (Wayland or no VO window)"
		return out
	}
	out["mpvWindowId"] = mpvWin
	var parent C.ulong
	var x, y, mapped C.int
	var w, h C.uint
	if rc := C.queryParent(C.ulong(mpvWin), &parent, &x, &y, &w, &h, &mapped); rc != 0 {
		out["error"] = fmt.Sprintf("XQueryTree rc=%d", int(rc))
		return out
	}
	out["mpvGeometry"] = fmt.Sprintf("%d,%d %dx%d", x, y, w, h)
	out["embedded"] = int64(parent) == target.WID
	out["verdict"] = map[bool]string{true: "mpv window is a child of the Wails toplevel", false: "mpv window is not parented to the Wails toplevel"}[int64(parent) == target.WID]
	return out
}

func makeTransparent(w *application.WebviewWindow) {
	application.InvokeSync(func() { C.makeTransparent(w.NativeWindow()) })
}

func attachOverlay(main, overlay *application.WebviewWindow) {
	application.InvokeSync(func() { C.setTransient(overlay.NativeWindow(), main.NativeWindow()) })
	overlay.Focus()
}

// GTK and mpv's X window track the window size by themselves.
func resizeVideoHost(*Player) {}

// --- process accounting -----------------------------------------------------

func rssMB() float64 {
	b, err := os.ReadFile("/proc/self/statm")
	if err != nil {
		return 0
	}
	var size, resident int64
	fmt.Sscan(string(b), &size, &resident)
	return float64(resident*int64(os.Getpagesize())) / (1 << 20)
}

func procSnapshot() map[int]string { return nil }

// systemProcs: our children (WebKitWebProcess, WebKitNetworkProcess) plus
// the display server / compositor processes the runner names in
// SPIKE_SYSTEM_PIDS ("Xvfb=12,picom=34").
func systemProcs(map[int]string) map[string][]int {
	out := map[string][]int{}
	self := os.Getpid()
	ents, _ := os.ReadDir("/proc")
	for _, e := range ents {
		pid, err := strconv.Atoi(e.Name())
		if err != nil {
			continue
		}
		if f := procStat(pid); len(f) > 3 && f[3] == strconv.Itoa(self) {
			out["children"] = append(out["children"], pid)
		}
	}
	for _, kv := range strings.Split(os.Getenv("SPIKE_SYSTEM_PIDS"), ",") {
		name, pid, ok := strings.Cut(kv, "=")
		if n, err := strconv.Atoi(pid); ok && err == nil {
			out[name] = append(out[name], n)
		}
	}
	return out
}

// procStat returns /proc/<pid>/stat's fields, with the command name (which
// may contain spaces) collapsed into field 1.
func procStat(pid int) []string {
	b, err := os.ReadFile(fmt.Sprintf("/proc/%d/stat", pid))
	if err != nil {
		return nil
	}
	s := string(b)
	i, j := strings.IndexByte(s, '('), strings.LastIndexByte(s, ')')
	if i < 0 || j < i {
		return nil
	}
	return append([]string{s[:i-1], s[i+1 : j]}, strings.Fields(s[j+1:])...)
}

func procCPU(pids []int) map[int]float64 {
	out := map[int]float64{}
	for _, pid := range pids {
		if f := procStat(pid); len(f) > 15 {
			u, _ := strconv.ParseFloat(f[13], 64)
			s, _ := strconv.ParseFloat(f[14], 64)
			out[pid] = (u + s) / 100 // USER_HZ
		}
	}
	return out
}

func selfCPU() float64 {
	var ru syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return float64(ru.Utime.Sec) + float64(ru.Utime.Usec)/1e6 + float64(ru.Stime.Sec) + float64(ru.Stime.Usec)/1e6
}

// gpuUtil: no GPU in the containers (llvmpipe), so nothing to sample.
func gpuUtil() (float64, bool) { return 0, false }

func debugCounters(*Player) string { return "" }
