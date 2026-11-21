//go:build ios

// What the Objective-C video host exposes to Go (host_ios.m).
#ifndef PELI_HOST_IOS_H
#define PELI_HOST_IOS_H

// peli_host_attach puts a GLES video view under the webview of the given
// WailsViewController (window.NativeWindow()), makes the webview transparent
// and creates mpv's render context on handle (an mpv_handle*). It returns 0,
// or a negative step number (-1 not a view controller, -2 no webView,
// -3 render context). Must run on a thread that may block on the main queue.
int peli_host_attach(void *viewController, void *handle);
// peli_host_detach frees the render context (before mpv_terminate_destroy),
// removes the view and gives the webview its backing back.
void peli_host_detach(void);
// peli_host_awake keeps the screen on (1) or lets it sleep (0).
void peli_host_awake(int on);
// peli_host_park stops all OpenGL ES work and returns once the render queue
// is idle: iOS kills an app that draws in the background. peli_host_unpark
// lets it draw again. Both repeat safely.
void peli_host_park(void);
void peli_host_unpark(void);
// Audio events for Go (peliAudioEvent, exported from engine.go).
#define PELI_AUDIO_INTERRUPTED 1
#define PELI_AUDIO_INTERRUPTION_ENDED 2
#define PELI_AUDIO_ROUTE_LOST 3
void peliAudioEvent(int kind, int shouldResume);
// peli_dev_audio_event posts the notification iOS would, for the dev rig.
void peli_dev_audio_event(int kind, int shouldResume);
// Lifecycle notifications for Go (peliLifecycle, exported from engine.go),
// delivered on the main thread, in the notification itself.
#define PELI_LIFECYCLE_WILL_RESIGN 1
#define PELI_LIFECYCLE_DID_BACKGROUND 2
#define PELI_LIFECYCLE_DID_ACTIVE 3
void peliLifecycle(int kind);
void peli_lifecycle_observe(void);
// peli_audio_session sets the .playback category and activates it.
int peli_audio_session(void);
// peli_is_simulator is 1 in the iOS simulator, whose software OpenGL ES
// can't map VideoToolbox frames.
int peli_is_simulator(void);
// peli_is_phone is 1 on an iPhone (the phone idiom), 0 on an iPad.
int peli_is_phone(void);
// peli_bundle_build copies the app's CFBundleVersion (SideStore builds stamp
// YYYYMMDD.HHMM there) into buf, NUL-terminated; 0 when it has none.
int peli_bundle_build(char *buf, int size);
// peli_show_webview fades in the webview that peli_quiet_webview (called from
// build/ios/main.m when Wails lays it out) kept clear until the page's first
// paint. It also runs on its own after 4 s, so a page that never reports
// can't leave the screen blank.
void peli_show_webview(void);
// The motion sensor's side of the phone, for the player's rotation
// (motion_ios.m). peli_motion_start calls peliMotionSide (exported from
// device.go) each time the side the phone is held on changes, from a
// background queue, until peli_motion_stop. peli_turn asks the scene to show
// exactly that side.
#define PELI_SIDE_PORTRAIT 0
#define PELI_SIDE_LANDSCAPE_LEFT 1
#define PELI_SIDE_LANDSCAPE_RIGHT 2
void peli_motion_start(void);
void peli_motion_stop(void);
void peli_turn(int side);
void peliMotionSide(int side);
// peli_system_captions is 1 when iOS asks for captions.
int peli_system_captions(void);
// The touch player's swipes (#131). peli_brightness_set changes the player
// window's screen brightness (0–1), saving the screen's own level on the
// first change; peli_brightness_restore puts that back and forgets it. The
// app resigning active restores it too, and becoming active again in the
// player puts the player's level back. peli_brightness_get is -1 when there
// is no screen.
void peli_brightness_set(double v);
double peli_brightness_get(void);
void peli_brightness_restore(void);
// peli_volume_set sets the system volume (0–1) through the hidden
// MPVolumeView's slider that peli_host_attach adds: 0, or -1 when the slider
// isn't there. peli_volume_get is AVAudioSession's outputVolume. While the
// host is attached, peliSystemVolume (exported from Go) gets every change,
// the hardware buttons' included.
int peli_volume_set(double v);
double peli_volume_get(void);
void peliSystemVolume(double v);
// peli_immersive hides the status bar and the home indicator and keeps the
// first swipe from an edge for the app (1), or gives them back (0).
void peli_immersive(int on);
// peli_host_width is the video view's width in points, 0 when there is no
// view. The docked watch party's inset is a share of it.
double peli_host_width(void);

#endif
