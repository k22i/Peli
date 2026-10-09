// The software render API path (MPV_RENDER_API_TYPE_SW), shared by macOS and
// Linux: a dedicated render thread renders into memory and hands each frame
// to a per-OS present function, which shows it as an image under the webview.
// Header-only; include it from exactly one translation unit per OS.
#pragma once

#include <mpv/render.h>
#include <stdlib.h>

#include "video.h"

// present runs on the render thread. It must copy the pixels before returning.
typedef void (*sw_present_fn)(const void *pixels, int w, int h, size_t stride);

typedef struct {
	mpv_handle *mpv;
	mpv_render_context *rctx;
	fstats *fs;
	sw_present_fn present;
	pthread_t th;
	pthread_mutex_t mu;
	pthread_cond_t cv;
	int update, stop, want_w, want_h;
	volatile int ready; // 1 render context up, -1 failed
} swr;

static void sw_wakeup(void *ctx) {
	swr *s = ctx;
	pthread_mutex_lock(&s->mu);
	s->update = 1;
	pthread_cond_signal(&s->cv);
	pthread_mutex_unlock(&s->mu);
}

// sw_resize is called from the UI thread when the video area changes size.
static void sw_resize(swr *s, int w, int h) {
	pthread_mutex_lock(&s->mu);
	s->want_w = w;
	s->want_h = h;
	s->update = 1;
	pthread_cond_signal(&s->cv);
	pthread_mutex_unlock(&s->mu);
}

static void *sw_thread(void *arg) {
	swr *s = arg;
	mpv_render_param cp[] = {{MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_SW}, {0}};
	if (mpv_render_context_create(&s->rctx, s->mpv, cp) < 0) {
		s->ready = -1;
		return NULL;
	}
	mpv_render_context_set_update_callback(s->rctx, sw_wakeup, s);
	s->ready = 1;
	void *buf = NULL;
	size_t cap = 0;
	int last_w = 0, last_h = 0;
	for (;;) {
		pthread_mutex_lock(&s->mu);
		while (!s->update && !s->stop) pthread_cond_wait(&s->cv, &s->mu);
		int stop = s->stop, w = s->want_w, h = s->want_h;
		s->update = 0;
		pthread_mutex_unlock(&s->mu);
		if (stop) break;
		uint64_t flags = mpv_render_context_update(s->rctx);
		int frame = (flags & MPV_RENDER_UPDATE_FRAME) != 0;
		if ((!frame && w == last_w && h == last_h) || w <= 0 || h <= 0) continue;
		size_t stride = ((size_t)w * 4 + 63) & ~(size_t)63;
		if (stride * h > cap) {
			free(buf);
			cap = stride * h;
			buf = malloc(cap);
		}
		int size[2] = {w, h};
		mpv_render_param rp[] = {
			{MPV_RENDER_PARAM_SW_SIZE, size},
			{MPV_RENDER_PARAM_SW_FORMAT, "rgb0"},
			{MPV_RENDER_PARAM_SW_STRIDE, &stride},
			{MPV_RENDER_PARAM_SW_POINTER, buf},
			{0},
		};
		int64_t t0 = fs_now();
		mpv_render_context_render(s->rctx, rp);
		s->present(buf, w, h, stride);
		fs_render(s->fs, frame, t0, fs_now(), w, h);
		mpv_render_context_report_swap(s->rctx);
		last_w = w;
		last_h = h;
	}
	mpv_render_context_free(s->rctx);
	s->rctx = NULL;
	free(buf);
	return NULL;
}

static void sw_start(swr *s) {
	pthread_mutex_init(&s->mu, NULL);
	pthread_cond_init(&s->cv, NULL);
	pthread_create(&s->th, NULL, sw_thread, s);
}

// sw_stop frees the render context (on the render thread) and joins it.
static void sw_stop(swr *s) {
	pthread_mutex_lock(&s->mu);
	s->stop = 1;
	pthread_cond_signal(&s->cv);
	pthread_mutex_unlock(&s->mu);
	pthread_join(s->th, NULL);
}
