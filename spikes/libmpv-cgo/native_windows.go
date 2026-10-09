//go:build windows

package main

import (
	"fmt"
	"os"
	"syscall"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

var (
	user32            = windows.NewLazySystemDLL("user32.dll")
	kernel32          = windows.NewLazySystemDLL("kernel32.dll")
	procFindWindowExW = user32.NewProc("FindWindowExW")
	procGetWindow     = user32.NewProc("GetWindow")
	procGetParent     = user32.NewProc("GetParent")
	procGetClassNameW = user32.NewProc("GetClassNameW")
	procGetWindowRect = user32.NewProc("GetWindowRect")
	procGetClientRect = user32.NewProc("GetClientRect")
	procSetWindowPos  = user32.NewProc("SetWindowPos")
	procEnableWindow  = user32.NewProc("EnableWindow")
	procIsWindowVis   = user32.NewProc("IsWindowVisible")
	procSetWindowLong = user32.NewProc("SetWindowLongPtrW")
	procCreateWindow  = user32.NewProc("CreateWindowExW")
	procGetMemInfo    = kernel32.NewProc("K32GetProcessMemoryInfo")
)

const (
	gwChild        = 5
	gwHwndNext     = 2
	hwndBottom     = 1
	swpNoSize      = 0x0001
	swpNoMove      = 0x0002
	swpNoZOrder    = 0x0004
	swpNoActivate  = 0x0010
	gwlpHwndParent = ^uintptr(8 - 1) // -8
	wsChild        = 0x40000000
	wsVisible      = 0x10000000
	wsDisabled     = 0x08000000
	wsClipSiblings = 0x04000000
	wsClipChildren = 0x02000000
	ssBlackRect    = 0x00000004
	mpvWindowClass = "mpv"
)

type nativeTarget struct {
	WID  int64
	Kind string
	Host string
	Note string
}

// container is the child HWND we hand to mpv in SPIKE_WIN_HOST=container mode.
var container uintptr

func videoTarget(p *Player) nativeTarget {
	host := uintptr(p.window.NativeWindow())
	if envOr("SPIKE_WIN_HOST", "window") != "container" {
		// In-process, the full 64-bit HWND goes straight into the int64 option.
		return nativeTarget{WID: int64(host), Kind: "HWND", Host: "window", Note: "top-level HWND of the Wails window"}
	}
	// A disabled, black STATIC child at the bottom of the z-order. mpv creates
	// its own window inside it, so mpv can never end up above WebView2's
	// HWND, even when it recreates its window, and hit-testing skips it.
	// WS_CLIPCHILDREN stops the STATIC's own (black) paint covering mpv's
	// window; SPIKE_WIN_CLIPCHILDREN=0 leaves it off to show the difference.
	style := uintptr(wsChild | wsVisible | wsDisabled | wsClipSiblings | ssBlackRect)
	if envOr("SPIKE_WIN_CLIPCHILDREN", "1") == "1" {
		style |= wsClipChildren
	}
	application.InvokeSync(func() {
		w, h := clientSize(host)
		cls, _ := syscall.UTF16PtrFromString("STATIC")
		container, _, _ = procCreateWindow.Call(0, uintptr(unsafe.Pointer(cls)), 0,
			style, 0, 0, uintptr(w), uintptr(h), host, 0, 0, 0)
		procSetWindowPos.Call(container, hwndBottom, 0, 0, 0, 0, swpNoSize|swpNoMove|swpNoActivate)
	})
	if container == 0 {
		return nativeTarget{WID: 0}
	}
	return nativeTarget{WID: int64(container), Kind: "HWND", Host: "container", Note: "disabled STATIC child of the Wails HWND, at HWND_BOTTOM"}
}

func clientSize(h uintptr) (int32, int32) {
	var r struct{ L, T, R, B int32 }
	procGetClientRect.Call(h, uintptr(unsafe.Pointer(&r)))
	return r.R - r.L, r.B - r.T
}

// resizeVideoHost keeps the container covering the client area; mpv follows
// its parent's size by itself.
func resizeVideoHost(p *Player) {
	if container == 0 {
		return
	}
	host := uintptr(p.window.NativeWindow())
	application.InvokeAsync(func() {
		w, h := clientSize(host)
		procSetWindowPos.Call(container, 0, 0, 0, uintptr(w), uintptr(h), swpNoZOrder|swpNoActivate)
	})
}

func fixLocale() map[string]any { return nil }

func className(h uintptr) string {
	buf := make([]uint16, 256)
	n, _, _ := procGetClassNameW.Call(h, uintptr(unsafe.Pointer(&buf[0])), 256)
	return syscall.UTF16ToString(buf[:n])
}

func rectOf(h uintptr) string {
	var r struct{ L, T, R, B int32 }
	procGetWindowRect.Call(h, uintptr(unsafe.Pointer(&r)))
	return fmt.Sprintf("%d,%d %dx%d", r.L, r.T, r.R-r.L, r.B-r.T)
}

// children lists the direct child windows of h in z-order, topmost first.
func children(h uintptr) []string {
	var out []string
	c, _, _ := procGetWindow.Call(h, gwChild)
	for c != 0 {
		vis, _, _ := procIsWindowVis.Call(c)
		out = append(out, fmt.Sprintf("%s(0x%x vis=%d %s)", className(c), c, vis, rectOf(c)))
		c, _, _ = procGetWindow.Call(c, gwHwndNext)
	}
	return out
}

func inspectEmbed(p *Player, target nativeTarget) map[string]any {
	host := uintptr(p.window.NativeWindow())
	parentWant := uintptr(target.WID)
	cls, _ := syscall.UTF16PtrFromString(mpvWindowClass)
	mpvWin, _, _ := procFindWindowExW.Call(parentWant, 0, uintptr(unsafe.Pointer(cls)), 0)
	out := map[string]any{
		"hostHwnd":       fmt.Sprintf("0x%x", host),
		"widHwnd":        fmt.Sprintf("0x%x", parentWant),
		"videoHost":      target.Host,
		"childrenBefore": children(host),
	}
	if mpvWin == 0 {
		out["embedded"] = false
		out["verdict"] = "no mpv child window found under the wid HWND"
		return out
	}
	parent, _, _ := procGetParent.Call(mpvWin)
	out["mpvHwnd"] = fmt.Sprintf("0x%x", mpvWin)
	out["mpvParent"] = fmt.Sprintf("0x%x", parent)
	out["mpvRect"] = rectOf(mpvWin)
	out["embedded"] = parent == parentWant

	// With wid = the top-level HWND, mpv's window is a sibling of WebView2's
	// and their z-order is a race (#2 gotcha 3). Push mpv's to the bottom and
	// disable it, as in #2. The container already sits at the bottom.
	if target.Host == "window" {
		z := envOr("SPIKE_WIN_ZORDER", "bottom")
		if z == "bottom" {
			procSetWindowPos.Call(mpvWin, hwndBottom, 0, 0, 0, 0, swpNoSize|swpNoMove|swpNoActivate)
		}
		if envOr("SPIKE_WIN_DISABLE", "1") == "1" {
			procEnableWindow.Call(mpvWin, 0)
		}
		out["zorder"] = z
		out["mpvDisabled"] = envOr("SPIKE_WIN_DISABLE", "1") == "1"
	}
	out["childrenAfter"] = children(host)
	if parent == parentWant {
		out["verdict"] = "mpv window is a child of the wid HWND (" + target.Host + ")"
	} else {
		out["verdict"] = "mpv window is not parented to the wid HWND"
	}
	return out
}

func makeTransparent(*application.WebviewWindow) {}

func attachOverlay(main, overlay *application.WebviewWindow) {
	// An owned top-level always stays above its owner and minimises with it.
	procSetWindowLong.Call(uintptr(overlay.NativeWindow()), gwlpHwndParent, uintptr(main.NativeWindow()))
}

func rssMB() float64 {
	var c struct {
		CB                                       uint32
		PageFaultCount                           uint32
		PeakWorkingSetSize, WorkingSetSize       uintptr
		QuotaPeakPagedPoolUsage, QuotaPagedPool  uintptr
		QuotaPeakNonPagedPool, QuotaNonPagedPool uintptr
		PagefileUsage, PeakPagefileUsage         uintptr
	}
	c.CB = uint32(unsafe.Sizeof(c))
	procGetMemInfo.Call(uintptr(windows.CurrentProcess()), uintptr(unsafe.Pointer(&c)), uintptr(c.CB))
	return float64(c.WorkingSetSize) / (1 << 20)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
