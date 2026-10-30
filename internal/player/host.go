package player

// host puts mpv's video under the webview, in the app window. There is one
// per OS (ADR-0002): a CAOpenGLLayer view on macOS, GdkGLTextures in a
// GtkPicture on Linux, mpv's own child window (wid) on Windows. A session
// calls its methods in this order, never on the UI thread; the host moves
// what must run there onto it itself.
type host interface {
	// prepare runs before mpv_create.
	prepare() error
	// configure sets the host's options (vo, wid) before mpv_initialize.
	configure(m *mpv) error
	// attach adds the video surface and creates the render context, after
	// mpv_initialize and before the first loadfile.
	attach(m *mpv) error
	// videoConfigured reports vo-configured changes: the VO came up, or was
	// re-initialised, such as for a new file.
	videoConfigured(on bool)
	// playing reports whether video is playing, for the OS's power
	// management (App Nap on macOS).
	playing(on bool)
	// canShowHDR reports whether the surface can take HDR (BT.2100 PQ) from
	// mpv, after attach. False where mpv shows HDR by itself (Windows), or
	// can't (Linux).
	canShowHDR() bool
	// showHDR switches the surface to HDR, or back to SDR, while mpv
	// switches what it renders to.
	showHDR(on bool)
	// detach frees the render context and removes the video surface, after
	// the event loop has stopped and before mpv_terminate_destroy.
	detach()
}

// nullHost plays without video output: the tests, and any machine where the
// video host can't be set up.
type nullHost struct{}

func (nullHost) prepare() error { return nil }

func (nullHost) configure(m *mpv) error {
	for _, o := range [][2]string{{"vo", "null"}, {"ao", "null"}} {
		if err := m.setOptionString(o[0], o[1]); err != nil {
			return err
		}
	}
	return nil
}

func (nullHost) attach(*mpv) error    { return nil }
func (nullHost) videoConfigured(bool) {}
func (nullHost) playing(bool)         {}
func (nullHost) canShowHDR() bool     { return false }
func (nullHost) showHDR(bool)         {}
func (nullHost) detach()              {}
