package player

/*
#cgo pkg-config: gtk4 epoxy
#cgo CFLAGS: -Wno-deprecated-declarations
#include <locale.h>
#include "video.h"

void peli_video_clear(void);

static void cNumericLocale(void) { setlocale(LC_NUMERIC, "C"); }
*/
import "C"

import (
	"errors"
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// hwdecAPIs: VA-API (Intel, AMD), then NVDEC or whatever else mpv deems
// safe.
const hwdecAPIs = "vaapi,auto-safe"

// linuxHost renders with the render API on its own thread, into textures a
// GtkPicture below the webview shows (video_linux.c), on X11 and Wayland.
type linuxHost struct {
	window   *application.WebviewWindow
	attached bool
}

func newHost(window *application.WebviewWindow) (host, error) {
	return &linuxHost{window: window}, nil
}

// prepare resets LC_NUMERIC to "C" after GTK's setlocale(LC_ALL, ""), or
// mpv_create refuses to run on a non-English desktop (M0, #3).
func (h *linuxHost) prepare() error {
	if h.window.NativeWindow() == nil {
		return errors.New("the window isn't open")
	}
	application.InvokeSync(func() { C.cNumericLocale() })
	return nil
}

func (h *linuxHost) configure(m *mpv) error {
	return m.setOptionString("vo", "libmpv")
}

func (h *linuxHost) attach(m *mpv) error {
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

func (h *linuxHost) videoConfigured(bool) {}

// playing: desktop Linux has no App Nap. Keeping the screen awake while
// playing (the Inhibit portal or org.freedesktop.ScreenSaver) isn't done yet.
func (h *linuxHost) playing(bool) {}

// canShowHDR: GTK shows our textures as SDR, so mpv tone-maps HDR.
func (h *linuxHost) canShowHDR() bool { return false }
func (h *linuxHost) showHDR(bool)     {}

// smooth: not on Linux yet (#103); mpv draws when a frame is due.
func (h *linuxHost) smooth(bool) float64 { return 0 }

func (h *linuxHost) detach() {
	if !h.attached {
		return
	}
	h.attached = false
	// GTK lets go of the textures first, so the render thread can free them.
	application.InvokeSync(func() { C.peli_video_clear() })
	C.peli_video_stop()
	application.InvokeSync(func() { C.peli_video_detach() })
}
