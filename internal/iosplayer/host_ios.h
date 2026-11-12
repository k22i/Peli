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
// peli_audio_session sets the .playback category and activates it.
int peli_audio_session(void);
// peli_system_captions is 1 when iOS asks for captions.
int peli_system_captions(void);

#endif
