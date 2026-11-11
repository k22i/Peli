package player

/*
#cgo CFLAGS: -Wno-deprecated-declarations
#cgo LDFLAGS: -framework Cocoa -framework QuartzCore -framework CoreVideo -framework OpenGL -framework WebKit
#include "video.h"

void peli_video_playing(int on);
int peli_video_can_show_hdr(void);
void peli_video_show_hdr(int on);
double peli_video_smooth(int on);
*/
import "C"

import (
	"errors"
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// hwdecAPIs: VideoToolbox, the only decoder API on macOS.
const hwdecAPIs = "videotoolbox,auto-safe"

// darwinHost renders with the render API into a CAOpenGLLayer view below
// the WKWebView (video_darwin.m).
type darwinHost struct {
	window   *application.WebviewWindow
	attached bool
}

func newHost(window *application.WebviewWindow) (host, error) {
	return &darwinHost{window: window}, nil
}

func (h *darwinHost) prepare() error {
	if h.window.NativeWindow() == nil {
		return errors.New("the window isn't open")
	}
	return nil
}

func (h *darwinHost) configure(m *mpv) error {
	return m.setOptionString("vo", "libmpv")
}

func (h *darwinHost) attach(m *mpv) error {
	err := application.InvokeSyncWithResult(func() error {
		var buf [256]C.char
		if C.peli_video_attach(h.window.NativeWindow(), &buf[0], C.int(len(buf))) != 0 {
			return fmt.Errorf("video host: %s", C.GoString(&buf[0]))
		}
		return nil
	})
	if err != nil {
		return err
	}
	h.attached = true
	var buf [256]C.char
	if C.peli_video_start(m.handle(), &buf[0], C.int(len(buf))) != 0 {
		h.detach()
		return fmt.Errorf("video host: %s", C.GoString(&buf[0]))
	}
	return nil
}

func (h *darwinHost) videoConfigured(bool) {}

func (h *darwinHost) playing(on bool) {
	C.peli_video_playing(cbool(on))
}

// canShowHDR is true when the window's screen could show EDR as the
// session opened (an XDR or HDR-enabled display): the layer then has a
// half-float back buffer.
func (h *darwinHost) canShowHDR() bool {
	return h.attached && C.peli_video_can_show_hdr() != 0
}

func (h *darwinHost) showHDR(on bool) {
	application.InvokeSync(func() { C.peli_video_show_hdr(cbool(on)) })
}

// smooth draws every vsync while on, and gives the display's refresh rate:
// the render API doesn't know it.
func (h *darwinHost) smooth(on bool) float64 {
	if !h.attached {
		return 0
	}
	return float64(C.peli_video_smooth(cbool(on)))
}

func (h *darwinHost) detach() {
	if !h.attached {
		return
	}
	h.attached = false
	C.peli_video_stop()
	application.InvokeSync(func() { C.peli_video_detach() })
}

func cbool(b bool) C.int {
	if b {
		return 1
	}
	return 0
}
