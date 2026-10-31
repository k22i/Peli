package player

/*
void sinag_window_mini(void *win, int on, double aspect);
*/
import "C"

import "github.com/wailsapp/wails/v3/pkg/application"

// setMini makes window the mini player, or the app window again, in
// mini_darwin.m.
func setMini(window *application.WebviewWindow, on bool, aspect float64) error {
	application.InvokeSync(func() {
		C.sinag_window_mini(window.NativeWindow(), cbool(on), C.double(aspect))
	})
	return nil
}
