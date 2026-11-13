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
// peli_system_captions is 1 when iOS asks for captions.
int peli_system_captions(void);

#endif
