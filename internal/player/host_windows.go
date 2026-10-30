package player

import (
	"errors"
	"syscall"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
	"golang.org/x/sys/windows"
)

var (
	user32            = windows.NewLazySystemDLL("user32.dll")
	procFindWindowExW = user32.NewProc("FindWindowExW")
	procSetWindowPos  = user32.NewProc("SetWindowPos")
	procEnableWindow  = user32.NewProc("EnableWindow")
)

const (
	hwndBottom    = 1
	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpNoActivate = 0x0010
)

// mpvClass is the class of the child window mpv makes for wid.
var mpvClass, _ = syscall.UTF16PtrFromString("mpv")

// windowsHost has mpv make its own child window in Wails' window (wid),
// pushed to the bottom of the z-order below WebView2's and disabled, so the
// transparent webview stays on top and gets all input (M0, #2 and #3). The
// render API has no Direct3D, so there's no render context here.
type windowsHost struct {
	window *application.WebviewWindow
	hwnd   uintptr
}

func newHost(window *application.WebviewWindow) (host, error) {
	return &windowsHost{window: window}, nil
}

// prepare waits for nothing: the window exists by the time anything plays.
// wid=0 would make mpv draw on the desktop, so a missing HWND is an error.
func (h *windowsHost) prepare() error {
	h.hwnd = uintptr(h.window.NativeWindow())
	if h.hwnd == 0 {
		return errors.New("the window isn't open")
	}
	return nil
}

// configure pins the VO: mpv silently falls back to one that ignores wid.
func (h *windowsHost) configure(m *mpv) error {
	if err := m.setOptionString("vo", "gpu-next"); err != nil {
		return err
	}
	return m.setOptionInt64("wid", int64(h.hwnd))
}

// attach makes the webview transparent, so mpv's window shows through it.
// WebView2 only takes a fully transparent or opaque background.
func (h *windowsHost) attach(*mpv) error {
	application.InvokeSync(func() { h.window.SetBackgroundColour(application.NewRGBA(0, 0, 0, 0)) })
	return nil
}

// videoConfigured puts mpv's window at the bottom again each time the VO
// comes up: mpv recreates it on a VO re-init.
func (h *windowsHost) videoConfigured(on bool) {
	if !on {
		return
	}
	application.InvokeAsync(func() {
		child, _, _ := procFindWindowExW.Call(h.hwnd, 0, uintptr(unsafe.Pointer(mpvClass)), 0)
		if child == 0 {
			return
		}
		procSetWindowPos.Call(child, hwndBottom, 0, 0, 0, 0, swpNoSize|swpNoMove|swpNoActivate)
		procEnableWindow.Call(child, 0)
	})
}

// playing: keeping the screen awake while playing (SetThreadExecutionState)
// isn't done yet.
func (h *windowsHost) playing(bool) {}

// detach leaves the window colour to the frontend, which owns it (the theme
// repaints it when the player closes); mpv_terminate_destroy takes mpv's
// window.
func (h *windowsHost) detach() {}
