package player

/*
void peli_window_mini(void *win, int on, double aspect);
void peli_window_fill(void *win);
void peli_window_restore(void *win);
*/
import "C"

import "github.com/wailsapp/wails/v3/pkg/application"

// setMini makes window the mini player, or the app window again, in
// mini_darwin.m.
func setMini(window *application.WebviewWindow, on bool, aspect float64) error {
	application.InvokeSync(func() {
		C.peli_window_mini(window.NativeWindow(), cbool(on), C.double(aspect))
	})
	return nil
}

// fillScreen has window fill its screen for playback, in mini_darwin.m.
func fillScreen(window *application.WebviewWindow) {
	application.InvokeSync(func() { C.peli_window_fill(window.NativeWindow()) })
}

// restoreWindow puts window back as it was before playback, in
// mini_darwin.m.
func restoreWindow(window *application.WebviewWindow) {
	application.InvokeSync(func() { C.peli_window_restore(window.NativeWindow()) })
}
