// Shared between Go and the per-OS render code (video_darwin.m,
// video_linux.c): the C entry points the Go side calls, and the frame-timing
// stats the render code collects.
#pragma once

#include <mpv/client.h>
#include <pthread.h>
#include <stdint.h>
#include <string.h>
#include <time.h>

// Video host modes that use the render API. The wid modes (Linux X11 only)
// never reach the C render code.
enum {
	SPIKE_MODE_GL = 1,         // macOS: CAOpenGLLayer view under the WKWebView
	SPIKE_MODE_SW = 2,         // render API "sw" into memory, shown as an image
	SPIKE_MODE_GLAREA = 3,     // Linux: GtkGLArea under the WebKitWebView
	SPIKE_MODE_SUBSURFACE = 4, // Wayland: our own wl_subsurface below GTK's
	SPIKE_MODE_GLTEX = 5,      // Linux: GdkGLTextures rendered on our own thread
};

#define FS_MAX 8192

// fstats is written by whichever thread renders and read by Go, under mu.
typedef struct {
	pthread_mutex_t mu;
	int64_t renders;        // mpv_render_context_render calls
	int64_t frames;         // ... of which mpv flagged a new video frame
	int64_t last_frame_ns;  // monotonic time of the last new-frame render
	int n_interval, n_cpu, n_gpu;
	double interval_ms[FS_MAX]; // between consecutive new-frame renders
	double cpu_ms[FS_MAX];      // wall time of the render call (plus swap where we own it)
	double gpu_ms[FS_MAX];      // GL_TIME_ELAPSED around the render call
	int w, h;                   // last render target size in pixels
	// HDR readback (macOS): max / mean of the RGB channels of one frame, and
	// the share of pixels brighter than SDR reference white.
	int readback_done;
	double rb_max, rb_mean, rb_over_white;
	char note[256];
} fstats;

static inline int64_t fs_now(void) {
	struct timespec ts;
	clock_gettime(CLOCK_MONOTONIC, &ts);
	return (int64_t)ts.tv_sec * 1000000000LL + ts.tv_nsec;
}

static inline void fs_render(fstats *fs, int new_frame, int64_t t0, int64_t t1, int w, int h) {
	pthread_mutex_lock(&fs->mu);
	fs->renders++;
	fs->w = w;
	fs->h = h;
	if (fs->n_cpu < FS_MAX) fs->cpu_ms[fs->n_cpu++] = (t1 - t0) / 1e6;
	if (new_frame) {
		fs->frames++;
		if (fs->last_frame_ns && fs->n_interval < FS_MAX)
			fs->interval_ms[fs->n_interval++] = (t0 - fs->last_frame_ns) / 1e6;
		fs->last_frame_ns = t0;
	}
	pthread_mutex_unlock(&fs->mu);
}

static inline void fs_gpu(fstats *fs, double ms) {
	pthread_mutex_lock(&fs->mu);
	if (fs->n_gpu < FS_MAX) fs->gpu_ms[fs->n_gpu++] = ms;
	pthread_mutex_unlock(&fs->mu);
}

static inline void fs_note(fstats *fs, const char *s) {
	pthread_mutex_lock(&fs->mu);
	strncpy(fs->note, s, sizeof fs->note - 1);
	pthread_mutex_unlock(&fs->mu);
}

// fs_copy copies the stats out and, if reset, starts a new measurement window
// (keeping the target size and note).
static inline void fs_copy(fstats *fs, fstats *out, int reset) {
	pthread_mutex_lock(&fs->mu);
	memcpy((char *)out + sizeof(pthread_mutex_t), (char *)fs + sizeof(pthread_mutex_t),
		sizeof(fstats) - sizeof(pthread_mutex_t));
	if (reset) {
		fs->renders = fs->frames = 0;
		fs->last_frame_ns = 0;
		fs->n_interval = fs->n_cpu = fs->n_gpu = 0;
	}
	pthread_mutex_unlock(&fs->mu);
}

// Implemented per OS. "win" is the platform window (NSWindow* / GtkWindow*).
// attach and detach run on the UI thread.
int spike_video_attach(void *win, mpv_handle *mpv, int mode, int hdr, char *err, int errlen);
int spike_video_ready(void); // 1 render context up, 0 not yet, -1 failed
void spike_video_detach(void);
void spike_video_stats(fstats *out, int reset);
void spike_video_readback(void); // macOS: read back the next frame (HDR check)
