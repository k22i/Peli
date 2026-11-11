package player

import (
	"errors"
	"log/slog"
	"runtime"
	"sync"
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

	kernel32                    = windows.NewLazySystemDLL("kernel32.dll")
	procSetThreadExecutionState = kernel32.NewProc("SetThreadExecutionState")
)

const (
	hwndBottom    = 1
	swpNoSize     = 0x0001
	swpNoMove     = 0x0002
	swpNoActivate = 0x0010

	esContinuous      = 0x80000000
	esSystemRequired  = 0x00000001
	esDisplayRequired = 0x00000002
)

// hwdecAPIs: D3D11VA, which every Windows GPU driver has, then whatever
// else mpv deems safe.
const hwdecAPIs = "d3d11va,auto-safe"

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
// With target-colorspace-hint=auto, mpv's own window switches its swap chain
// to HDR10 for an HDR video when Windows' HDR is on for the display, and
// tone-maps otherwise. media-controls has libmpv run the System Media
// Transport Controls (#67), off by default for libmpv; a build without them
// lacks the option, which isn't worth failing playback over.
func (h *windowsHost) configure(m *mpv) error {
	for _, o := range [][2]string{{"vo", "gpu-next"}, {"target-colorspace-hint", "auto"}} {
		if err := m.setOptionString(o[0], o[1]); err != nil {
			return err
		}
	}
	if err := m.setOptionString("media-controls", "yes"); err != nil {
		slog.Warn("player: no media controls", "error", err)
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

// playing keeps the display and the machine awake while video plays (#102),
// as macOS's activity does (video_darwin.m).
func (h *windowsHost) playing(on bool) { keepAwake(on) }

// Windows keeps a thread's execution state for that thread only, and drops
// it when the thread ends: Go moves goroutines between threads, so one
// goroutine locked to its own thread sets it, every time.
var (
	awakeOnce sync.Once
	awakeMu   sync.Mutex
	awake     chan bool
)

func keepAwake(on bool) {
	awakeOnce.Do(func() {
		awake = make(chan bool, 1)
		go func() {
			// Never unlocked: the state lives as long as this thread does.
			runtime.LockOSThread()
			for on := range awake {
				state := uintptr(esContinuous)
				if on {
					state |= esSystemRequired | esDisplayRequired
				}
				if r, _, err := procSetThreadExecutionState.Call(state); r == 0 {
					slog.Warn("player: screen awake not set", "error", err)
				}
			}
		}()
	})
	// The newest wins: one waiting is enough.
	awakeMu.Lock()
	defer awakeMu.Unlock()
	select {
	case <-awake:
	default:
	}
	awake <- on
}

// canShowHDR: mpv's window does it by itself (configure).
func (h *windowsHost) canShowHDR() bool { return false }
func (h *windowsHost) showHDR(bool)     {}

// smooth: mpv's own window paces itself and knows its display.
func (h *windowsHost) smooth(bool) float64 { return 0 }

// detach leaves the window colour to the frontend, which owns it (the theme
// repaints it when the player closes); mpv_terminate_destroy takes mpv's
// window.
func (h *windowsHost) detach() {}
