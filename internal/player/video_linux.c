// Linux video host (ADR-0002), for X11 and Wayland: "gltex" from M0 (#4).
// Wails' GTK4 window is GtkWindow > GtkBox > WebKitWebView; we put a
// GtkOverlay in the webview's place, with a GtkPicture as its child and the
// transparent webview stacked on top. mpv renders on our own thread into one
// of a few FBO-backed textures, in a GL context shared with GTK's; the GTK
// thread wraps the finished one in a GdkGLTexture (with a fence, so GTK
// waits for the GPU) and shows it. GTK hands the slot back when it drops the
// texture. Never GtkGLArea: rendering on the GTK thread starved Wails' main
// thread dispatch for up to 176 s in M0.
//
// libepoxy (GTK's own GL loader) for both GL and EGL; mixing it with the
// system EGL/egl.h headers clashes.
#include <dlfcn.h>
#include <epoxy/egl.h>
#include <epoxy/gl.h>
#include <gtk/gtk.h>
#include <mpv/render_gl.h>
#include <pthread.h>
#include <stdatomic.h>
#include <time.h>
#ifdef GDK_WINDOWING_WAYLAND
#include <gdk/wayland/gdkwayland.h>
#endif
#ifdef GDK_WINDOWING_X11
#include <gdk/x11/gdkx.h>
#endif

#include "video.h"

// GTK keeps the textures of the last frame or two alive (render-node
// diffing, its texture cache) before releasing them.
#define NSLOTS 6

static GtkWidget *g_picture; // made once, kept (hidden) between sessions
static GtkWidget *g_web;
static GdkRGBA g_web_background;
static guint g_tick;

// WebKitGTK's, declared here rather than pulling in its headers.
typedef struct _WebKitWebView WebKitWebView;
void webkit_web_view_get_background_color(WebKitWebView *web, GdkRGBA *rgba);
void webkit_web_view_set_background_color(WebKitWebView *web, const GdkRGBA *rgba);

static struct {
	GdkGLContext *ctx;
	mpv_handle *mpv;
	pthread_t th;
	pthread_mutex_t mu;
	pthread_cond_t cv;
	int update, stop, ready, want_w, want_h; // ready: 1 up, -1 failed
	char err[256];
	struct {
		GLuint tex, fbo;
		int w, h;
		GLsync sync;
		atomic_int busy; // GTK holds it, or it's queued for GTK
	} slot[NSLOTS];
	atomic_int pending; // slot index + 1 waiting to be shown, 0 if none
	atomic_int gen;     // the session, for tex_release
} T = {.mu = PTHREAD_MUTEX_INITIALIZER, .cv = PTHREAD_COND_INITIALIZER};

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

static int add_display_params(mpv_render_param *p, int n) {
	GdkDisplay *d = gdk_display_get_default();
#ifdef GDK_WINDOWING_WAYLAND
	if (GDK_IS_WAYLAND_DISPLAY(d))
		p[n++] = (mpv_render_param){MPV_RENDER_PARAM_WL_DISPLAY, gdk_wayland_display_get_wl_display(d)};
#endif
#ifdef GDK_WINDOWING_X11
	if (GDK_IS_X11_DISPLAY(d))
		p[n++] = (mpv_render_param){MPV_RENDER_PARAM_X11_DISPLAY, gdk_x11_display_get_xdisplay(d)};
#endif
	return n;
}

// tex_wakeup is mpv's update callback, on an mpv thread: no libmpv calls.
static void tex_wakeup(void *ctx) {
	pthread_mutex_lock(&T.mu);
	T.update = 1;
	pthread_cond_signal(&T.cv);
	pthread_mutex_unlock(&T.mu);
}

// tex_release is GTK dropping a texture. GTK may let go of a session's last
// textures only once it draws again, in the next session: those releases
// carry an old generation and are ignored, or they'd free slots GTK is
// showing now.
static void tex_release(gpointer data) {
	int tag = GPOINTER_TO_INT(data);
	if (tag / NSLOTS != atomic_load(&T.gen)) return;
	atomic_store(&T.slot[tag % NSLOTS].busy, 0);
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
	GdkTexture *t = gdk_gl_texture_builder_build(b, tex_release, GINT_TO_POINTER(atomic_load(&T.gen) * NSLOTS + i));
	g_object_unref(b);
	gtk_picture_set_paintable(GTK_PICTURE(g_picture), GDK_PAINTABLE(t));
	g_object_unref(t);
	return G_SOURCE_REMOVE;
}

// tex_tick follows the picture's size in pixels (resize, fullscreen, a
// monitor with another scale).
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

static void set_ready(int ready) {
	pthread_mutex_lock(&T.mu);
	T.ready = ready;
	pthread_cond_broadcast(&T.cv);
	pthread_mutex_unlock(&T.mu);
}

static void *tex_thread(void *arg) {
	gdk_gl_context_make_current(T.ctx);
	mpv_opengl_init_params gl = {.get_proc_address = get_proc};
	mpv_render_param cp[4] = {
		{MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL},
		{MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl},
	};
	add_display_params(cp, 2);
	mpv_render_context *rctx = NULL;
	int rc = mpv_render_context_create(&rctx, T.mpv, cp);
	if (rc < 0) {
		snprintf(T.err, sizeof T.err, "mpv_render_context_create: %s", mpv_error_string(rc));
		gdk_gl_context_clear_current();
		set_ready(-1);
		return NULL;
	}
	mpv_render_context_set_update_callback(rctx, tex_wakeup, NULL);
	set_ready(1);
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
		if (i < 0) continue; // dropped: GTK held every slot for 100 ms
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
			{0},
		};
		mpv_render_context_render(rctx, p);
		T.slot[i].sync = glFenceSync(GL_SYNC_GPU_COMMANDS_COMPLETE, 0);
		glFlush();
		atomic_store(&T.slot[i].busy, 1);
		int old = atomic_exchange(&T.pending, i + 1) - 1;
		if (old >= 0) atomic_store(&T.slot[old].busy, 0); // GTK never saw it: drop
		else g_idle_add_full(G_PRIORITY_DEFAULT, tex_show, NULL, NULL);
		mpv_render_context_report_swap(rctx);
		last_w = w, last_h = h;
	}
	mpv_render_context_free(rctx);
	// The textures go once GTK has let go of them (peli_video_clear took
	// them off the picture first), or after half a second regardless: a
	// hidden picture may not be drawn again to release them.
	for (int tries = 0; tries < 250; tries++) {
		int busy = 0;
		for (int k = 0; k < NSLOTS; k++) busy |= atomic_load(&T.slot[k].busy);
		if (!busy) break;
		struct timespec ts = {0, 2000000};
		nanosleep(&ts, NULL);
	}
	for (int k = 0; k < NSLOTS; k++) {
		if (T.slot[k].sync) glDeleteSync(T.slot[k].sync);
		if (T.slot[k].fbo) glDeleteFramebuffers(1, &T.slot[k].fbo);
		if (T.slot[k].tex) glDeleteTextures(1, &T.slot[k].tex);
		T.slot[k].sync = NULL, T.slot[k].fbo = T.slot[k].tex = 0, T.slot[k].w = T.slot[k].h = 0;
		atomic_store(&T.slot[k].busy, 0);
	}
	atomic_store(&T.pending, 0);
	gdk_gl_context_clear_current();
	return NULL;
}

int peli_video_attach(void *win, char *err, int errlen) {
	if (!g_picture) {
		GtkWidget *web = find_webview(GTK_WIDGET(win));
		if (!web) {
			snprintf(err, errlen, "no WebKitWebView in the window");
			return -1;
		}
		g_web = web;
		g_picture = gtk_picture_new();
		gtk_picture_set_content_fit(GTK_PICTURE(g_picture), GTK_CONTENT_FIT_FILL);
		gtk_picture_set_can_shrink(GTK_PICTURE(g_picture), TRUE);
		gtk_widget_set_can_target(g_picture, FALSE); // input goes to the webview
		put_below(web, g_picture);
	}
	GError *e = NULL;
	// Contexts made for a surface share with GTK's own, so its renderer can
	// sample our textures.
	T.ctx = gdk_surface_create_gl_context(gtk_native_get_surface(GTK_NATIVE(win)), &e);
	if (T.ctx && !gdk_gl_context_realize(T.ctx, &e)) g_clear_object(&T.ctx);
	if (!T.ctx) {
		snprintf(err, errlen, "GL context: %s", e ? e->message : "?");
		g_clear_error(&e);
		return -1;
	}
	gdk_gl_context_clear_current();
	gtk_widget_set_visible(g_picture, TRUE);
	// The webview paints the window colour unless told not to.
	webkit_web_view_get_background_color((WebKitWebView *)g_web, &g_web_background);
	GdkRGBA clear = {0, 0, 0, 0};
	webkit_web_view_set_background_color((WebKitWebView *)g_web, &clear);
	T.want_w = T.want_h = 0;
	g_tick = gtk_widget_add_tick_callback(g_picture, tex_tick, NULL, NULL);
	return 0;
}

int peli_video_start(mpv_handle *mpv, char *err, int errlen) {
	T.mpv = mpv;
	T.stop = T.update = T.ready = 0;
	atomic_fetch_add(&T.gen, 1);
	if (pthread_create(&T.th, NULL, tex_thread, NULL) != 0) {
		snprintf(err, errlen, "no render thread");
		return -1;
	}
	pthread_mutex_lock(&T.mu);
	while (!T.ready) pthread_cond_wait(&T.cv, &T.mu);
	int ready = T.ready;
	pthread_mutex_unlock(&T.mu);
	if (ready < 0) {
		pthread_join(T.th, NULL);
		snprintf(err, errlen, "%s", T.err);
		return -1;
	}
	return 0;
}

void peli_video_stop(void) {
	if (!T.mpv) return;
	pthread_mutex_lock(&T.mu);
	T.stop = 1;
	pthread_cond_signal(&T.cv);
	pthread_mutex_unlock(&T.mu);
	pthread_join(T.th, NULL);
	T.mpv = NULL;
}

// peli_video_clear drops the picture's texture, so GTK lets go of our
// slots, and hides it. On the GTK thread, before peli_video_stop.
void peli_video_clear(void) {
	if (!g_picture) return;
	if (g_tick) gtk_widget_remove_tick_callback(g_picture, g_tick);
	g_tick = 0;
	gtk_picture_set_paintable(GTK_PICTURE(g_picture), NULL);
	gtk_widget_set_visible(g_picture, FALSE);
}

void peli_video_detach(void) {
	g_clear_object(&T.ctx);
	if (g_web) webkit_web_view_set_background_color((WebKitWebView *)g_web, &g_web_background);
}
