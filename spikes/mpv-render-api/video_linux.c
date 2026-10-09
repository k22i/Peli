// Linux video hosts for the render API. Wails' GTK4 window is
// GtkWindow > GtkBox > WebKitWebView; we find the webview and put the video
// below it:
//
//   glarea      GtkOverlay { GtkGLArea (mpv renders here, on the GTK thread),
//                            overlay: the transparent WebKitWebView }
//   sw          the same, with a GtkPicture fed by a software render thread
//   gltex       the same GtkPicture, fed GdkGLTextures that mpv renders on our
//               own thread, in a GL context shared with GTK's (X11 + Wayland)
//   subsurface  Wayland only: no GTK widget at all. We create our own
//               wl_surface as a wl_subsurface of GTK's toplevel surface,
//               placed *below* it, and render into it with EGL on our own
//               thread. GTK's transparent window and webview let it show
//               through; the compositor does the blending.
// libepoxy (GTK's own GL loader) for both GL and EGL; mixing it with the
// system EGL/egl.h headers clashes.
#include <dlfcn.h>
#include <epoxy/egl.h>
#include <epoxy/gl.h>
#include <gtk/gtk.h>
#include <mpv/render_gl.h>
#include <stdatomic.h>
#ifdef GDK_WINDOWING_WAYLAND
#include <gdk/wayland/gdkwayland.h>
#include <wayland-client.h>
#include <wayland-egl.h>
#endif
#ifdef GDK_WINDOWING_X11
#include <gdk/x11/gdkx.h>
#endif

#include "swrender.h"
#include "video.h"

static fstats g_fs = {.mu = PTHREAD_MUTEX_INITIALIZER};
static int g_mode, g_block = 1;
static mpv_handle *g_mpv;
static atomic_int g_ready, g_queued;
static GtkWidget *g_web, *g_area, *g_picture;
static mpv_render_context *g_rctx; // glarea: only used on the GTK thread
static GLuint g_query;
static int g_query_pending;
static char g_info[512];

static void *get_proc(void *ctx, const char *name) {
	// GTK 4 uses EGL on both Wayland and X11 unless it fell back to GLX.
	if (eglGetCurrentContext() != EGL_NO_CONTEXT) return (void *)eglGetProcAddress(name);
	static void *(*glx)(const char *);
	if (!glx) glx = dlsym(RTLD_DEFAULT, "glXGetProcAddressARB");
	return glx ? glx(name) : dlsym(RTLD_DEFAULT, name);
}

static GtkWidget *find_webview(GtkWidget *w) {
	if (strcmp(G_OBJECT_TYPE_NAME(w), "WebKitWebView") == 0) return w;
	for (GtkWidget *c = gtk_widget_get_first_child(w); c; c = gtk_widget_get_next_sibling(c)) {
		GtkWidget *found = find_webview(c);
		if (found) return found;
	}
	return NULL;
}

// put_below replaces the webview in its parent box with an overlay that has
// the video widget as its main child and the webview stacked on top.
static void put_below(GtkWidget *web, GtkWidget *video) {
	GtkWidget *parent = gtk_widget_get_parent(web);
	g_object_ref(web);
	gtk_box_remove(GTK_BOX(parent), web);
	GtkWidget *ov = gtk_overlay_new();
	gtk_widget_set_hexpand(ov, TRUE);
	gtk_widget_set_vexpand(ov, TRUE);
	gtk_widget_set_hexpand(video, TRUE);
	gtk_widget_set_vexpand(video, TRUE);
	gtk_overlay_set_child(GTK_OVERLAY(ov), video);
	gtk_overlay_add_overlay(GTK_OVERLAY(ov), web);
	gtk_box_append(GTK_BOX(parent), ov);
	g_object_unref(web);
}

static void add_display_params(mpv_render_param *p, int *n) {
	GdkDisplay *d = gdk_display_get_default();
#ifdef GDK_WINDOWING_WAYLAND
	if (GDK_IS_WAYLAND_DISPLAY(d))
		p[(*n)++] = (mpv_render_param){MPV_RENDER_PARAM_WL_DISPLAY, gdk_wayland_display_get_wl_display(d)};
#endif
#ifdef GDK_WINDOWING_X11
	if (GDK_IS_X11_DISPLAY(d))
		p[(*n)++] = (mpv_render_param){MPV_RENDER_PARAM_X11_DISPLAY, gdk_x11_display_get_xdisplay(d)};
#endif
}

// gpu_time reads the previous frame's GL_TIME_ELAPSED query, if it's ready,
// and returns whether a new one can start.
static int gpu_time_begin(GLuint q, int *pending) {
	if (*pending) {
		GLint avail = 0;
		glGetQueryObjectiv(q, GL_QUERY_RESULT_AVAILABLE, &avail);
		if (!avail) return 0;
		GLuint64 ns = 0;
		glGetQueryObjectui64v(q, GL_QUERY_RESULT, &ns);
		fs_gpu(&g_fs, ns / 1e6);
		*pending = 0;
	}
	glBeginQuery(GL_TIME_ELAPSED, q);
	return 1;
}

static void gpu_time_end(int *pending) {
	glEndQuery(GL_TIME_ELAPSED);
	*pending = 1;
}

// --- glarea ---------------------------------------------------------------

static gboolean queue_render(gpointer d) {
	atomic_store(&g_queued, 0);
	if (g_area) gtk_gl_area_queue_render(GTK_GL_AREA(g_area));
	return G_SOURCE_REMOVE;
}

// on_update runs on an mpv thread: no libmpv calls, just schedule a render.
static void on_update(void *ctx) {
	// SPIKE_HIGH_PRIO=1 schedules above GTK's redraw priority; the default
	// stays at the same idle priority Wails' main-thread dispatch uses.
	static int prio = -1;
	if (prio == -1) prio = getenv("SPIKE_HIGH_PRIO") ? G_PRIORITY_HIGH : G_PRIORITY_DEFAULT_IDLE;
	if (!atomic_exchange(&g_queued, 1)) g_idle_add_full(prio, queue_render, NULL, NULL);
}

static void on_realize(GtkGLArea *area, gpointer d) {
	gtk_gl_area_make_current(area);
	if (gtk_gl_area_get_error(area)) {
		fs_note(&g_fs, gtk_gl_area_get_error(area)->message);
		atomic_store(&g_ready, -1);
		return;
	}
	mpv_opengl_init_params gl = {.get_proc_address = get_proc};
	mpv_render_param p[6] = {
		{MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL},
		{MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl},
	};
	int n = 2;
	add_display_params(p, &n);
	if (mpv_render_context_create(&g_rctx, g_mpv, p) < 0) {
		fs_note(&g_fs, "mpv_render_context_create failed");
		atomic_store(&g_ready, -1);
		return;
	}
	mpv_render_context_set_update_callback(g_rctx, on_update, NULL);
	glGenQueries(1, &g_query);
	GdkGLContext *c = gtk_gl_area_get_context(area);
	snprintf(g_info, sizeof g_info, "GtkGLArea under the webview; %s %s; GL_RENDERER=%s; GL_VERSION=%s; render blocks for target time: %s",
		eglGetCurrentContext() != EGL_NO_CONTEXT ? "EGL" : "GLX", gdk_gl_context_get_use_es(c) ? "GLES" : "GL",
		glGetString(GL_RENDERER), glGetString(GL_VERSION), g_block ? "yes" : "no");
	atomic_store(&g_ready, 1);
}

static gboolean on_render(GtkGLArea *area, GdkGLContext *ctx, gpointer d) {
	if (!g_rctx) return FALSE;
	uint64_t flags = mpv_render_context_update(g_rctx);
	GLint fbo = 0;
	glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &fbo);
	int s = gtk_widget_get_scale_factor(GTK_WIDGET(area));
	int w = gtk_widget_get_width(GTK_WIDGET(area)) * s, h = gtk_widget_get_height(GTK_WIDGET(area)) * s;
	mpv_opengl_fbo target = {.fbo = fbo, .w = w, .h = h};
	int flip = 1;
	mpv_render_param p[] = {
		{MPV_RENDER_PARAM_OPENGL_FBO, &target},
		{MPV_RENDER_PARAM_FLIP_Y, &flip},
		{MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &g_block},
		{0},
	};
	int timing = gpu_time_begin(g_query, &g_query_pending);
	int64_t t0 = fs_now();
	mpv_render_context_render(g_rctx, p);
	int64_t t1 = fs_now();
	if (timing) gpu_time_end(&g_query_pending);
	fs_render(&g_fs, (flags & MPV_RENDER_UPDATE_FRAME) != 0, t0, t1, w, h);
	// GTK swaps after this returns; close enough for mpv's timing.
	mpv_render_context_report_swap(g_rctx);
	return TRUE;
}

// --- sw ---------------------------------------------------------------------

static swr g_sw;
static GdkTexture *_Atomic g_next_tex;

static gboolean show_texture(gpointer d) {
	GdkTexture *t = atomic_exchange(&g_next_tex, NULL);
	if (t && g_picture) gtk_picture_set_paintable(GTK_PICTURE(g_picture), GDK_PAINTABLE(t));
	if (t) g_object_unref(t);
	return G_SOURCE_REMOVE;
}

static void sw_present(const void *px, int w, int h, size_t stride) {
	GBytes *b = g_bytes_new(px, stride * h);
	GdkTexture *t = gdk_memory_texture_new(w, h, GDK_MEMORY_R8G8B8X8, b, stride);
	g_bytes_unref(b);
	GdkTexture *old = atomic_exchange(&g_next_tex, t);
	if (old) g_object_unref(old); // the UI thread hasn't shown the last one yet: drop it
	else g_idle_add_full(G_PRIORITY_HIGH, show_texture, NULL, NULL);
}

static gboolean sw_tick(GtkWidget *w, GdkFrameClock *fc, gpointer d) {
	int s = gtk_widget_get_scale_factor(w);
	int pw = gtk_widget_get_width(w) * s, ph = gtk_widget_get_height(w) * s;
	if (pw != g_sw.want_w || ph != g_sw.want_h) sw_resize(&g_sw, pw, ph);
	return G_SOURCE_CONTINUE;
}

// --- gltex -----------------------------------------------------------------
// mpv renders on our thread into one of a few FBO-backed textures; the GTK
// thread wraps the finished one in a GdkGLTexture (with a fence, so GTK waits
// for the GPU) and shows it in a GtkPicture. GTK hands the slot back when it
// drops the texture.

// GTK keeps the textures of the last frame or two alive (render-node diffing,
// its texture cache) before releasing them.
#define NSLOTS 6
static struct {
	GdkGLContext *ctx;
	pthread_t th;
	pthread_mutex_t mu;
	pthread_cond_t cv;
	int update, stop, want_w, want_h;
	struct {
		GLuint tex, fbo;
		int w, h;
		GLsync sync;
		atomic_int busy; // GTK holds it, or it's queued for GTK
	} slot[NSLOTS];
	atomic_int pending; // slot index + 1 waiting to be shown, 0 if none
} T = {.mu = PTHREAD_MUTEX_INITIALIZER, .cv = PTHREAD_COND_INITIALIZER};

static void tex_wakeup(void *ctx) {
	pthread_mutex_lock(&T.mu);
	T.update = 1;
	pthread_cond_signal(&T.cv);
	pthread_mutex_unlock(&T.mu);
}

static void tex_release(gpointer data) {
	atomic_store(&T.slot[GPOINTER_TO_INT(data)].busy, 0);
	pthread_mutex_lock(&T.mu);
	pthread_cond_signal(&T.cv);
	pthread_mutex_unlock(&T.mu);
}

static gboolean tex_show(gpointer d) {
	int i = atomic_exchange(&T.pending, 0) - 1;
	if (i < 0 || !g_picture) return G_SOURCE_REMOVE;
	GdkGLTextureBuilder *b = gdk_gl_texture_builder_new();
	gdk_gl_texture_builder_set_context(b, T.ctx);
	gdk_gl_texture_builder_set_id(b, T.slot[i].tex);
	gdk_gl_texture_builder_set_width(b, T.slot[i].w);
	gdk_gl_texture_builder_set_height(b, T.slot[i].h);
	gdk_gl_texture_builder_set_sync(b, T.slot[i].sync);
	GdkTexture *t = gdk_gl_texture_builder_build(b, tex_release, GINT_TO_POINTER(i));
	g_object_unref(b);
	gtk_picture_set_paintable(GTK_PICTURE(g_picture), GDK_PAINTABLE(t));
	g_object_unref(t);
	return G_SOURCE_REMOVE;
}

static gboolean tex_tick(GtkWidget *w, GdkFrameClock *fc, gpointer d) {
	int s = gtk_widget_get_scale_factor(w);
	int pw = gtk_widget_get_width(w) * s, ph = gtk_widget_get_height(w) * s;
	pthread_mutex_lock(&T.mu);
	if (pw != T.want_w || ph != T.want_h) {
		T.want_w = pw, T.want_h = ph, T.update = 1;
		pthread_cond_signal(&T.cv);
	}
	pthread_mutex_unlock(&T.mu);
	return G_SOURCE_CONTINUE;
}

static void *tex_thread(void *arg) {
	gdk_gl_context_make_current(T.ctx);
	mpv_opengl_init_params gl = {.get_proc_address = get_proc};
	mpv_render_param cp[6] = {
		{MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL},
		{MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl},
	};
	int n = 2;
	add_display_params(cp, &n);
	mpv_render_context *rctx = NULL;
	if (mpv_render_context_create(&rctx, g_mpv, cp) < 0) {
		fs_note(&g_fs, "mpv_render_context_create failed");
		atomic_store(&g_ready, -1);
		return NULL;
	}
	mpv_render_context_set_update_callback(rctx, tex_wakeup, NULL);
	GLuint query;
	int pending = 0;
	glGenQueries(1, &query);
	snprintf(g_info, sizeof g_info, "GtkPicture under the webview, GdkGLTexture per frame rendered on a render thread (shared %s %s context); GL_RENDERER=%s; GL_VERSION=%s; render blocks for target time: %s",
		eglGetCurrentContext() != EGL_NO_CONTEXT ? "EGL" : "GLX", gdk_gl_context_get_use_es(T.ctx) ? "GLES" : "GL",
		glGetString(GL_RENDERER), glGetString(GL_VERSION), g_block ? "yes" : "no");
	atomic_store(&g_ready, 1);
	int last_w = 0, last_h = 0;
	for (;;) {
		pthread_mutex_lock(&T.mu);
		while (!T.update && !T.stop) pthread_cond_wait(&T.cv, &T.mu);
		int stop = T.stop, w = T.want_w, h = T.want_h;
		T.update = 0;
		pthread_mutex_unlock(&T.mu);
		if (stop) break;
		uint64_t flags = mpv_render_context_update(rctx);
		int frame = (flags & MPV_RENDER_UPDATE_FRAME) != 0;
		if ((!frame && w == last_w && h == last_h) || w <= 0 || h <= 0) continue;
		int i = -1;
		for (int tries = 0; i < 0 && tries < 50; tries++) {
			for (int k = 0; k < NSLOTS; k++)
				if (!atomic_load(&T.slot[k].busy)) { i = k; break; }
			if (i < 0) { // GTK still holds every slot: wait for a release
				struct timespec ts;
				clock_gettime(CLOCK_REALTIME, &ts);
				ts.tv_nsec += 2000000;
				if (ts.tv_nsec >= 1000000000) ts.tv_sec++, ts.tv_nsec -= 1000000000;
				pthread_mutex_lock(&T.mu);
				pthread_cond_timedwait(&T.cv, &T.mu, &ts);
				pthread_mutex_unlock(&T.mu);
			}
		}
		if (i < 0) {
			fs_note(&g_fs, "all texture slots busy for 100ms");
			continue;
		}
		if (T.slot[i].sync) glDeleteSync(T.slot[i].sync);
		if (!T.slot[i].tex || T.slot[i].w != w || T.slot[i].h != h) {
			if (!T.slot[i].tex) {
				glGenTextures(1, &T.slot[i].tex);
				glGenFramebuffers(1, &T.slot[i].fbo);
			}
			glBindTexture(GL_TEXTURE_2D, T.slot[i].tex);
			glTexImage2D(GL_TEXTURE_2D, 0, GL_RGBA8, w, h, 0, GL_RGBA, GL_UNSIGNED_BYTE, NULL);
			glTexParameteri(GL_TEXTURE_2D, GL_TEXTURE_MIN_FILTER, GL_LINEAR);
			glBindFramebuffer(GL_FRAMEBUFFER, T.slot[i].fbo);
			glFramebufferTexture2D(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_TEXTURE_2D, T.slot[i].tex, 0);
			T.slot[i].w = w, T.slot[i].h = h;
		}
		mpv_opengl_fbo target = {.fbo = T.slot[i].fbo, .w = w, .h = h, .internal_format = GL_RGBA8};
		int flip = 0; // GdkGLTexture expects row 0 at the top
		mpv_render_param p[] = {
			{MPV_RENDER_PARAM_OPENGL_FBO, &target},
			{MPV_RENDER_PARAM_FLIP_Y, &flip},
			{MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &g_block},
			{0},
		};
		int timing = gpu_time_begin(query, &pending);
		int64_t t0 = fs_now();
		mpv_render_context_render(rctx, p);
		if (timing) gpu_time_end(&pending);
		T.slot[i].sync = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
		glFlush();
		fs_render(&g_fs, frame, t0, fs_now(), w, h);
		atomic_store(&T.slot[i].busy, 1);
		int old = atomic_exchange(&T.pending, i + 1) - 1;
		if (old >= 0) atomic_store(&T.slot[old].busy, 0); // GTK never saw it: drop
		else g_idle_add_full(G_PRIORITY_DEFAULT, tex_show, NULL, NULL);
		mpv_render_context_report_swap(rctx);
		last_w = w, last_h = h;
	}
	mpv_render_context_free(rctx);
	gdk_gl_context_clear_current();
	return NULL;
}

static int tex_attach(GtkWindow *win, char *err, int errlen) {
	GError *e = NULL;
	// Contexts made for a surface share with GTK's own, so its renderer can
	// sample our textures.
	T.ctx = gdk_surface_create_gl_context(gtk_native_get_surface(GTK_NATIVE(win)), &e);
	if (T.ctx && !gdk_gl_context_realize(T.ctx, &e)) g_clear_object(&T.ctx);
	if (!T.ctx) {
		snprintf(err, errlen, "GL context: %s", e ? e->message : "?");
		return -1;
	}
	gdk_gl_context_clear_current();
	g_picture = gtk_picture_new();
	gtk_picture_set_content_fit(GTK_PICTURE(g_picture), GTK_CONTENT_FIT_FILL);
	gtk_picture_set_can_shrink(GTK_PICTURE(g_picture), TRUE);
	put_below(g_web, g_picture);
	gtk_widget_add_tick_callback(g_picture, tex_tick, NULL, NULL);
	pthread_create(&T.th, NULL, tex_thread, NULL);
	return 0;
}

static void tex_detach(void) {
	pthread_mutex_lock(&T.mu);
	T.stop = 1;
	pthread_cond_signal(&T.cv);
	pthread_mutex_unlock(&T.mu);
	pthread_join(T.th, NULL);
}

// --- subsurface (Wayland) --------------------------------------------------

#ifdef GDK_WINDOWING_WAYLAND
static struct {
	struct wl_display *dpy;
	struct wl_event_queue *queue;
	struct wl_compositor *comp;
	struct wl_subcompositor *subcomp;
	struct wl_surface *surf, *parent;
	struct wl_subsurface *sub;
	struct wl_egl_window *ewin;
	EGLDisplay edpy;
	EGLContext ectx;
	EGLSurface esurf;
	pthread_t th;
	pthread_mutex_t mu;
	pthread_cond_t cv;
	int update, stop, x, y, w, h, scale, resized;
} S = {.mu = PTHREAD_MUTEX_INITIALIZER, .cv = PTHREAD_COND_INITIALIZER};

static void reg_global(void *d, struct wl_registry *r, uint32_t name, const char *iface, uint32_t ver) {
	if (strcmp(iface, wl_compositor_interface.name) == 0)
		S.comp = wl_registry_bind(r, name, &wl_compositor_interface, ver < 4 ? ver : 4);
	else if (strcmp(iface, wl_subcompositor_interface.name) == 0)
		S.subcomp = wl_registry_bind(r, name, &wl_subcompositor_interface, 1);
}
static void reg_remove(void *d, struct wl_registry *r, uint32_t name) {}
static const struct wl_registry_listener reg_listener = {reg_global, reg_remove};

static void sub_wakeup(void *ctx) {
	pthread_mutex_lock(&S.mu);
	S.update = 1;
	pthread_cond_signal(&S.cv);
	pthread_mutex_unlock(&S.mu);
}

static void *sub_thread(void *arg) {
	// The EXT_platform_base entry points: libepoxy only dispatches the EGL 1.5
	// core ones once a display exists.
	S.edpy = eglGetPlatformDisplayEXT(EGL_PLATFORM_WAYLAND_EXT, S.dpy, NULL);
	EGLint major, minor, ncfg = 0;
	EGLConfig cfg;
	EGLint cattr[] = {EGL_SURFACE_TYPE, EGL_WINDOW_BIT, EGL_RENDERABLE_TYPE, EGL_OPENGL_BIT,
		EGL_RED_SIZE, 8, EGL_GREEN_SIZE, 8, EGL_BLUE_SIZE, 8, EGL_ALPHA_SIZE, 0, EGL_NONE};
	if (!eglInitialize(S.edpy, &major, &minor) || !eglBindAPI(EGL_OPENGL_API) ||
		!eglChooseConfig(S.edpy, cattr, &cfg, 1, &ncfg) || ncfg < 1) {
		fs_note(&g_fs, "EGL init/config failed");
		atomic_store(&g_ready, -1);
		return NULL;
	}
	S.ectx = eglCreateContext(S.edpy, cfg, EGL_NO_CONTEXT, NULL);
	pthread_mutex_lock(&S.mu);
	int w = S.w * S.scale, h = S.h * S.scale;
	S.resized = 0;
	pthread_mutex_unlock(&S.mu);
	S.ewin = wl_egl_window_create(S.surf, w > 0 ? w : 1, h > 0 ? h : 1);
	S.esurf = eglCreatePlatformWindowSurfaceEXT(S.edpy, cfg, S.ewin, NULL);
	if (!S.ectx || !S.esurf || !eglMakeCurrent(S.edpy, S.esurf, S.esurf, S.ectx)) {
		fs_note(&g_fs, "EGL context/surface failed");
		atomic_store(&g_ready, -1);
		return NULL;
	}
	eglSwapInterval(S.edpy, 1);
	mpv_opengl_init_params gl = {.get_proc_address = get_proc};
	mpv_render_param cp[] = {
		{MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL},
		{MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl},
		{MPV_RENDER_PARAM_WL_DISPLAY, S.dpy},
		{0},
	};
	mpv_render_context *rctx = NULL;
	if (mpv_render_context_create(&rctx, g_mpv, cp) < 0) {
		fs_note(&g_fs, "mpv_render_context_create failed");
		atomic_store(&g_ready, -1);
		return NULL;
	}
	mpv_render_context_set_update_callback(rctx, sub_wakeup, NULL);
	GLuint query;
	int pending = 0;
	glGenQueries(1, &query);
	snprintf(g_info, sizeof g_info, "wl_subsurface below the GTK toplevel; EGL %d.%d on a render thread; GL_RENDERER=%s; GL_VERSION=%s; render blocks for target time: %s",
		major, minor, glGetString(GL_RENDERER), glGetString(GL_VERSION), g_block ? "yes" : "no");
	atomic_store(&g_ready, 1);
	int first = 1;
	for (;;) {
		pthread_mutex_lock(&S.mu);
		while (!S.update && !S.stop) pthread_cond_wait(&S.cv, &S.mu);
		int stop = S.stop, resized = S.resized;
		w = S.w * S.scale;
		h = S.h * S.scale;
		S.update = S.resized = 0;
		pthread_mutex_unlock(&S.mu);
		if (stop) break;
		uint64_t flags = mpv_render_context_update(rctx);
		if (resized) wl_egl_window_resize(S.ewin, w, h, 0, 0);
		if (!(flags & MPV_RENDER_UPDATE_FRAME) && !resized && !first) continue;
		first = 0;
		mpv_opengl_fbo target = {.fbo = 0, .w = w, .h = h};
		int flip = 1;
		mpv_render_param p[] = {
			{MPV_RENDER_PARAM_OPENGL_FBO, &target},
			{MPV_RENDER_PARAM_FLIP_Y, &flip},
			{MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &g_block},
			{0},
		};
		int timing = gpu_time_begin(query, &pending);
		int64_t t0 = fs_now();
		mpv_render_context_render(rctx, p);
		if (timing) gpu_time_end(&pending);
		eglSwapBuffers(S.edpy, S.esurf); // waits for the subsurface's frame callback
		fs_render(&g_fs, (flags & MPV_RENDER_UPDATE_FRAME) != 0, t0, fs_now(), w, h);
		mpv_render_context_report_swap(rctx);
	}
	mpv_render_context_free(rctx);
	eglMakeCurrent(S.edpy, EGL_NO_SURFACE, EGL_NO_SURFACE, EGL_NO_CONTEXT);
	eglDestroySurface(S.edpy, S.esurf);
	eglDestroyContext(S.edpy, S.ectx);
	wl_egl_window_destroy(S.ewin);
	return NULL;
}

// sub_geometry puts the subsurface where the webview is, in surface
// coordinates (GTK's CSD shadow and header bar offset it), every frame.
static gboolean sub_tick(GtkWidget *web, GdkFrameClock *fc, gpointer d) {
	GtkNative *nat = gtk_widget_get_native(web);
	graphene_rect_t r;
	if (!nat || !gtk_widget_compute_bounds(web, GTK_WIDGET(nat), &r)) return G_SOURCE_CONTINUE;
	double sx, sy;
	gtk_native_get_surface_transform(nat, &sx, &sy);
	int x = (int)(sx + r.origin.x), y = (int)(sy + r.origin.y), w = (int)r.size.width, h = (int)r.size.height;
	int scale = gtk_widget_get_scale_factor(web);
	pthread_mutex_lock(&S.mu);
	int moved = x != S.x || y != S.y, sized = w != S.w || h != S.h || scale != S.scale;
	S.x = x, S.y = y, S.w = w, S.h = h, S.scale = scale;
	if (sized) S.resized = S.update = 1, pthread_cond_signal(&S.cv);
	pthread_mutex_unlock(&S.mu);
	if (moved) {
		// Double-buffered on the parent: applied when GTK next commits it.
		wl_subsurface_set_position(S.sub, x, y);
		gtk_widget_queue_draw(web);
	}
	if (sized) wl_surface_set_buffer_scale(S.surf, scale);
	return G_SOURCE_CONTINUE;
}

static int sub_attach(GtkWindow *win, char *err, int errlen) {
	GdkDisplay *d = gdk_display_get_default();
	if (!GDK_IS_WAYLAND_DISPLAY(d)) {
		snprintf(err, errlen, "subsurface mode needs a Wayland session");
		return -1;
	}
	S.dpy = gdk_wayland_display_get_wl_display(d);
	S.parent = gdk_wayland_surface_get_wl_surface(gtk_native_get_surface(GTK_NATIVE(win)));
	// Bind our own globals on a private queue so we never dispatch GDK's events.
	S.queue = wl_display_create_queue(S.dpy);
	struct wl_display *wrapped = wl_proxy_create_wrapper(S.dpy);
	wl_proxy_set_queue((struct wl_proxy *)wrapped, S.queue);
	struct wl_registry *reg = wl_display_get_registry(wrapped);
	wl_registry_add_listener(reg, &reg_listener, NULL);
	wl_display_roundtrip_queue(S.dpy, S.queue);
	wl_proxy_wrapper_destroy(wrapped);
	if (!S.comp || !S.subcomp) {
		snprintf(err, errlen, "compositor lacks wl_compositor/wl_subcompositor");
		return -1;
	}
	S.surf = wl_compositor_create_surface(S.comp);
	struct wl_region *none = wl_compositor_create_region(S.comp);
	wl_surface_set_input_region(S.surf, none); // input goes to GTK's surface above
	wl_region_destroy(none);
	S.sub = wl_subcompositor_get_subsurface(S.subcomp, S.surf, S.parent);
	wl_subsurface_place_below(S.sub, S.parent);
	wl_subsurface_set_desync(S.sub); // our commits show up without waiting for GTK's
	sub_tick(g_web, NULL, NULL);
	gtk_widget_add_tick_callback(g_web, sub_tick, NULL, NULL);
	gtk_widget_queue_draw(GTK_WIDGET(win));
	pthread_create(&S.th, NULL, sub_thread, NULL);
	return 0;
}

static void sub_detach(void) {
	pthread_mutex_lock(&S.mu);
	S.stop = 1;
	pthread_cond_signal(&S.cv);
	pthread_mutex_unlock(&S.mu);
	pthread_join(S.th, NULL);
}
#endif

// --- entry points (GTK thread) ---------------------------------------------

int spike_video_attach(void *win, mpv_handle *mpv, int mode, int hdr, char *err, int errlen) {
	g_mode = mode;
	g_mpv = mpv;
	g_block = getenv("SPIKE_NO_BLOCK") == NULL;
	g_web = find_webview(GTK_WIDGET(win));
	if (!g_web) {
		snprintf(err, errlen, "no WebKitWebView in the window");
		return -1;
	}
	switch (mode) {
	case SPIKE_MODE_GLAREA:
		g_area = gtk_gl_area_new();
		gtk_gl_area_set_auto_render(GTK_GL_AREA(g_area), FALSE);
		g_signal_connect(g_area, "realize", G_CALLBACK(on_realize), NULL);
		g_signal_connect(g_area, "render", G_CALLBACK(on_render), NULL);
		put_below(g_web, g_area);
		return 0;
	case SPIKE_MODE_SW:
		g_picture = gtk_picture_new();
		gtk_picture_set_content_fit(GTK_PICTURE(g_picture), GTK_CONTENT_FIT_FILL);
		gtk_picture_set_can_shrink(GTK_PICTURE(g_picture), TRUE);
		put_below(g_web, g_picture);
		g_sw = (swr){.mpv = mpv, .fs = &g_fs, .present = sw_present};
		snprintf(g_info, sizeof g_info, "GtkPicture under the webview, GdkMemoryTexture per frame from MPV_RENDER_API_TYPE_SW (rgb0) on a render thread");
		sw_start(&g_sw);
		gtk_widget_add_tick_callback(g_picture, sw_tick, NULL, NULL);
		return 0;
	case SPIKE_MODE_GLTEX:
		return tex_attach(GTK_WINDOW(win), err, errlen);
#ifdef GDK_WINDOWING_WAYLAND
	case SPIKE_MODE_SUBSURFACE:
		return sub_attach(GTK_WINDOW(win), err, errlen);
#endif
	}
	snprintf(err, errlen, "unsupported mode %d", mode);
	return -1;
}

int spike_video_ready(void) {
	if (g_mode == SPIKE_MODE_SW) return g_sw.ready;
	return atomic_load(&g_ready);
}

void spike_video_detach(void) {
	switch (g_mode) {
	case SPIKE_MODE_GLAREA:
		if (g_rctx) {
			gtk_gl_area_make_current(GTK_GL_AREA(g_area));
			mpv_render_context_free(g_rctx);
			g_rctx = NULL;
		}
		break;
	case SPIKE_MODE_SW:
		if (g_sw.mpv) sw_stop(&g_sw);
		break;
	case SPIKE_MODE_GLTEX:
		tex_detach();
		break;
#ifdef GDK_WINDOWING_WAYLAND
	case SPIKE_MODE_SUBSURFACE:
		sub_detach();
		break;
#endif
	}
}

void spike_video_stats(fstats *out, int reset) { fs_copy(&g_fs, out, reset); }
void spike_video_readback(void) {}
const char *spike_video_info(void) { return g_info; }

// spike_video_layout describes the widget tree around the webview, to show
// where the video ended up.
void spike_video_layout(char *out, int n) {
	GtkWidget *p = g_web ? gtk_widget_get_parent(g_web) : NULL;
	if (!p) {
		snprintf(out, n, "no webview");
		return;
	}
	int len = snprintf(out, n, "%s {", G_OBJECT_TYPE_NAME(p));
	for (GtkWidget *c = gtk_widget_get_first_child(p); c && len < n; c = gtk_widget_get_next_sibling(c))
		len += snprintf(out + len, n - len, " %s", G_OBJECT_TYPE_NAME(c));
	if (len < n) snprintf(out + len, n - len, " } (later children draw on top)");
}

// spike_content_offset is where the webview's top-left sits, in the window's
// geometry (header bar included, CSD shadow excluded: what X11 and sway place
// at the window position), plus the CSD shadow offset of the surface. The
// runner scripts aim their input probes with it.
void spike_content_offset(void *win, int *x, int *y, int *shadow_x, int *shadow_y) {
	GtkWidget *web = find_webview(GTK_WIDGET(win));
	GtkNative *nat = web ? gtk_widget_get_native(web) : NULL;
	graphene_rect_t r;
	*x = *y = *shadow_x = *shadow_y = -1;
	if (!nat || !gtk_widget_compute_bounds(web, GTK_WIDGET(nat), &r)) return;
	double sx, sy;
	gtk_native_get_surface_transform(nat, &sx, &sy);
	*x = (int)r.origin.x;
	*y = (int)r.origin.y;
	*shadow_x = (int)sx;
	*shadow_y = (int)sy;
}
