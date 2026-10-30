// The C side of the render API hosts (video_darwin.m, video_linux.c), which
// host_darwin.go and host_linux.go call. One video surface per process: the
// app has one window.
#pragma once

#include <mpv/client.h>

// sinag_video_attach adds the video surface under the webview in win (an
// NSWindow* or a GtkWindow*). It runs on the UI thread and doesn't touch mpv.
int sinag_video_attach(void *win, char *err, int errlen);

// sinag_video_start creates the render context for mpv, on the render
// thread, and waits for it. It runs off the UI thread, before the first
// loadfile.
int sinag_video_start(mpv_handle *mpv, char *err, int errlen);

// sinag_video_stop frees the render context on the render thread and waits
// for it. It runs off the UI thread, before mpv_terminate_destroy.
void sinag_video_stop(void);

// sinag_video_detach removes the video surface. It runs on the UI thread.
void sinag_video_detach(void);
