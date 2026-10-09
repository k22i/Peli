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
	procFindWindowExW = user32.NewProc("FindWindowExW")
	procGetWindow     = user32.NewProc("GetWindow")
	procGetParent     = user32.NewProc("GetParent")
	procGetClassNameW = user32.NewProc("GetClassNameW")
	procGetWindowRect = user32.NewProc("GetWindowRect")
	procSetWindowPos  = user32.NewProc("SetWindowPos")
	procEnableWindow  = user32.NewProc("EnableWindow")
	procIsWindowVis   = user32.NewProc("IsWindowVisible")
	procSetWindowLong = user32.NewProc("SetWindowLongPtrW")
)

const (
	gwChild         = 5
	gwHwndNext      = 2
	hwndBottom      = 1
	swpNoSize       = 0x0001
	swpNoMove       = 0x0002
	swpNoActivate   = 0x0010
	gwlpHwndParent  = ^uintptr(8 - 1) // -8
	mpvWindowClass  = "mpv"
	defaultZOrder   = "bottom"
	defaultDisabled = "1"
)

type nativeTarget struct {
	WID  int64
	Kind string
	Note string
}

func windowTarget(w *application.WebviewWindow) nativeTarget {
	hwnd := uintptr(w.NativeWindow())
	// mpv wants the HWND as a non-negative uint32 (handles are 32-bit
	// significant even on 64-bit Windows).
	return nativeTarget{WID: int64(uint32(hwnd)), Kind: "HWND", Note: "top-level HWND of the Wails window"}
}

func extraMpvArgs() []string {
	if a := os.Getenv("SPIKE_MPV_ARGS"); a != "" {
		return splitArgs(a)
	}
	return nil
}

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
	cls, _ := syscall.UTF16PtrFromString(mpvWindowClass)
	mpvWin, _, _ := procFindWindowExW.Call(host, 0, uintptr(unsafe.Pointer(cls)), 0)
	out := map[string]any{
		"hostHwnd":       fmt.Sprintf("0x%x", host),
		"childrenBefore": children(host),
	}
	if mpvWin == 0 {
		out["embedded"] = false
		out["verdict"] = "no mpv child window found under the Wails HWND"
		return out
	}
	parent, _, _ := procGetParent.Call(mpvWin)
	out["mpvHwnd"] = fmt.Sprintf("0x%x", mpvWin)
	out["mpvParent"] = fmt.Sprintf("0x%x", parent)
	out["mpvRect"] = rectOf(mpvWin)
	out["embedded"] = parent == host

	// mpv's child HWND sits on top of WebView2's and eats mouse input. Push it
	// to the bottom of the sibling z-order and disable it so hit-testing
	// skips it (WindowFromPoint ignores disabled windows) and clicks reach
	// the webview / host instead.
	z := envOr("SPIKE_WIN_ZORDER", defaultZOrder)
	if z == "bottom" {
		procSetWindowPos.Call(mpvWin, hwndBottom, 0, 0, 0, 0, swpNoSize|swpNoMove|swpNoActivate)
	}
	if envOr("SPIKE_WIN_DISABLE", defaultDisabled) == "1" {
		procEnableWindow.Call(mpvWin, 0)
	}
	out["zorder"] = z
	out["mpvDisabled"] = envOr("SPIKE_WIN_DISABLE", defaultDisabled) == "1"
	out["childrenAfter"] = children(host)
	out["verdict"] = map[bool]string{true: "mpv window is a child of the Wails HWND", false: "mpv window is not parented to the Wails HWND"}[parent == host]
	return out
}

func makeTransparent(*application.WebviewWindow) {}

func attachOverlay(main, overlay *application.WebviewWindow) {
	// An owned top-level always stays above its owner and minimises with it.
	procSetWindowLong.Call(uintptr(overlay.NativeWindow()), gwlpHwndParent, uintptr(main.NativeWindow()))
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}
