// libmpv on iOS under a Wails WKWebView.
//
//   WailsViewController.view            (UIView, black)
//     ├─ PeliVideoView                  (CAEAGLLayer, mpv render API / OpenGL ES)   ← inserted here, index 0
//     └─ WKWebView                      (made non-opaque, clear background)         ← Wails' own
//
// mpv draws on a private serial queue with its own EAGLContext (needed current
// for the VideoToolbox → GLES texture-cache interop in hwdec_ios_gl.m), and
// presents the renderbuffer of the layer. The mpv client API drives
// everything else; property changes are forwarded to Go (goMpvEvent).

#import <UIKit/UIKit.h>
#import <OpenGLES/EAGL.h>
#import <OpenGLES/EAGLDrawable.h>
#import <OpenGLES/ES3/gl.h>
#import <QuartzCore/QuartzCore.h>
#include <dlfcn.h>
#include <stdatomic.h>
#include <mpv/client.h>
#include <mpv/render_gl.h>
#include "mpvview.h"

static mpv_handle *g_mpv;
static mpv_render_context *g_rctx;
static dispatch_queue_t g_evq;

// ---- JSON helpers ---------------------------------------------------------

static NSString *jsonString(const char *s) {
	if (!s) return @"null";
	NSMutableString *out = [NSMutableString stringWithString:@"\""];
	for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
		switch (*p) {
		case '"': [out appendString:@"\\\""]; break;
		case '\\': [out appendString:@"\\\\"]; break;
		case '\n': [out appendString:@"\\n"]; break;
		case '\r': [out appendString:@"\\r"]; break;
		case '\t': [out appendString:@"\\t"]; break;
		default:
			if (*p < 0x20) [out appendFormat:@"\\u%04x", *p];
			else [out appendFormat:@"%c", *p];
		}
	}
	[out appendString:@"\""];
	return out;
}

static void emit(const char *name, NSString *json) {
	goMpvEvent((char *)name, (char *)json.UTF8String);
}

// ---- the video view -------------------------------------------------------

@interface PeliVideoView : UIView
@property(nonatomic, strong) EAGLContext *glctx;
@property(nonatomic, strong) dispatch_queue_t rq;
@property(nonatomic) GLuint fbo, rbo;
@property(nonatomic) GLint w, h;
@property(nonatomic, readonly) long frameCount, renderMicros;
@end

@implementation PeliVideoView {
	_Atomic int _needsResize, _pending, _background;
	_Atomic long _frames, _renderUs;
}
+ (Class)layerClass { return [CAEAGLLayer class]; }

- (instancetype)initWithFrame:(CGRect)f {
	if (!(self = [super initWithFrame:f])) return nil;
	self.backgroundColor = UIColor.blackColor;
	self.userInteractionEnabled = NO; // touches go to the webview above
	CAEAGLLayer *l = (CAEAGLLayer *)self.layer;
	l.opaque = YES;
	l.contentsScale = UIScreen.mainScreen.scale;
	l.drawableProperties = @{kEAGLDrawablePropertyRetainedBacking: @NO,
	                         kEAGLDrawablePropertyColorFormat: kEAGLColorFormatRGBA8};
	_rq = dispatch_queue_create("peli.mpv.render", DISPATCH_QUEUE_SERIAL);
	atomic_store(&_needsResize, 1);
	NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
	[nc addObserverForName:UIApplicationDidEnterBackgroundNotification object:nil queue:nil
	            usingBlock:^(NSNotification *n) {
		// GL work in the background is killed by the OS: park the renderer.
		atomic_store(&self->_background, 1);
		dispatch_sync(self->_rq, ^{ glFinish(); });
	}];
	[nc addObserverForName:UIApplicationWillEnterForegroundNotification object:nil queue:nil
	            usingBlock:^(NSNotification *n) {
		atomic_store(&self->_background, 0);
		[self requestDraw];
	}];
	return self;
}

- (void)layoutSubviews {
	[super layoutSubviews];
	((CAEAGLLayer *)self.layer).contentsScale = self.window.screen.scale ?: UIScreen.mainScreen.scale;
	atomic_store(&_needsResize, 1);
	[self requestDraw];
}

// Must run on rq.
- (void)setupGL {
	_glctx = [[EAGLContext alloc] initWithAPI:kEAGLRenderingAPIOpenGLES3];
	[EAGLContext setCurrentContext:_glctx];
	glGenFramebuffers(1, &_fbo);
	glGenRenderbuffers(1, &_rbo);
	glBindFramebuffer(GL_FRAMEBUFFER, _fbo);
	glBindRenderbuffer(GL_RENDERBUFFER, _rbo);
	glFramebufferRenderbuffer(GL_FRAMEBUFFER, GL_COLOR_ATTACHMENT0, GL_RENDERBUFFER, _rbo);
}

- (void)resizeGL {
	glBindRenderbuffer(GL_RENDERBUFFER, _rbo);
	[_glctx renderbufferStorage:GL_RENDERBUFFER fromDrawable:(CAEAGLLayer *)self.layer];
	glGetRenderbufferParameteriv(GL_RENDERBUFFER, GL_RENDERBUFFER_WIDTH, &_w);
	glGetRenderbufferParameteriv(GL_RENDERBUFFER, GL_RENDERBUFFER_HEIGHT, &_h);
}

- (long)frameCount { return atomic_load(&_frames); }
- (long)renderMicros { return atomic_load(&_renderUs); }

- (void)requestDraw {
	if (!g_rctx || atomic_exchange(&_pending, 1)) return;
	dispatch_async(_rq, ^{
		atomic_store(&self->_pending, 0);
		[self draw];
	});
}

// On rq.
- (void)draw {
	if (!g_rctx || atomic_load(&_background)) return;
	[EAGLContext setCurrentContext:_glctx];
	BOOL resized = atomic_exchange(&_needsResize, 0);
	if (resized) [self resizeGL];
	uint64_t flags = mpv_render_context_update(g_rctx);
	if (!resized && !(flags & MPV_RENDER_UPDATE_FRAME)) return;
	CFAbsoluteTime t0 = CFAbsoluteTimeGetCurrent();
	glBindFramebuffer(GL_FRAMEBUFFER, _fbo);
	mpv_opengl_fbo fbo = {.fbo = (int)_fbo, .w = _w, .h = _h, .internal_format = GL_RGBA8};
	int flip = 1;
	mpv_render_param params[] = {
		{MPV_RENDER_PARAM_OPENGL_FBO, &fbo},
		{MPV_RENDER_PARAM_FLIP_Y, &flip},
		{MPV_RENDER_PARAM_INVALID, NULL},
	};
	mpv_render_context_render(g_rctx, params);
	glBindRenderbuffer(GL_RENDERBUFFER, _rbo);
	[_glctx presentRenderbuffer:GL_RENDERBUFFER];
	mpv_render_context_report_swap(g_rctx);
	atomic_fetch_add(&_frames, 1);
	atomic_fetch_add(&_renderUs, (long)((CFAbsoluteTimeGetCurrent() - t0) * 1e6));
}
@end

static PeliVideoView *g_view;

static void *get_proc_address(void *ctx, const char *name) {
	return dlsym(RTLD_DEFAULT, name);
}

static void on_update(void *ctx) { [g_view requestDraw]; }

// ---- mpv events → Go ---------------------------------------------------------

static void drain_events(void) {
	for (;;) {
		mpv_event *e = mpv_wait_event(g_mpv, 0);
		if (e->event_id == MPV_EVENT_NONE) return;
		switch (e->event_id) {
		case MPV_EVENT_PROPERTY_CHANGE: {
			mpv_event_property *p = e->data;
			NSString *j = @"null";
			if (p->format == MPV_FORMAT_DOUBLE) j = [NSString stringWithFormat:@"%.3f", *(double *)p->data];
			else if (p->format == MPV_FORMAT_FLAG) j = *(int *)p->data ? @"true" : @"false";
			else if (p->format == MPV_FORMAT_STRING) {
				const char *s = *(char **)p->data;
				// node properties come back as JSON text already
				j = (strcmp(p->name, "track-list") == 0 && s) ? [NSString stringWithUTF8String:s] : jsonString(s);
			}
			emit(p->name, j);
			break;
		}
		case MPV_EVENT_LOG_MESSAGE: {
			mpv_event_log_message *m = e->data;
			NSString *line = [NSString stringWithFormat:@"[%s] %s: %s", m->level, m->prefix, m->text];
			emit("log", jsonString(line.UTF8String));
			break;
		}
		case MPV_EVENT_START_FILE: emit("event", @"\"start-file\""); break;
		case MPV_EVENT_FILE_LOADED: emit("event", @"\"file-loaded\""); break;
		case MPV_EVENT_VIDEO_RECONFIG: emit("event", @"\"video-reconfig\""); break;
		case MPV_EVENT_AUDIO_RECONFIG: emit("event", @"\"audio-reconfig\""); break;
		case MPV_EVENT_SEEK: emit("event", @"\"seek\""); break;
		case MPV_EVENT_PLAYBACK_RESTART: emit("event", @"\"playback-restart\""); break;
		case MPV_EVENT_END_FILE: {
			mpv_event_end_file *ef = e->data;
			emit("event", [NSString stringWithFormat:@"\"end-file reason=%d error=%s\"", ef->reason,
			               ef->error < 0 ? mpv_error_string(ef->error) : "none"]);
			break;
		}
		default: break;
		}
	}
}

static void wakeup(void *ctx) { dispatch_async(g_evq, ^{ drain_events(); }); }

// ---- Go API -------------------------------------------------------------------

int peli_attach(void *handle, const char *hwdec) {
	if (g_mpv) return 0;
	__block int rc = 0;
	void (^work)(void) = ^{
		UIViewController *vc = (__bridge UIViewController *)handle;
		if (!vc || ![vc isKindOfClass:UIViewController.class]) { rc = -1; return; }
		UIView *root = vc.view;
		// Wails' WailsViewController has a `webView` property (WKWebView).
		UIView *web = nil;
		@try { web = [vc valueForKey:@"webView"]; } @catch (NSException *e) {}
		if (!web) { rc = -2; return; }

		PeliVideoView *v = [[PeliVideoView alloc] initWithFrame:root.bounds];
		v.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
		root.backgroundColor = UIColor.blackColor;
		[root insertSubview:v belowSubview:web];
		// A WKWebView is transparent only when neither it nor its scroll view is opaque.
		web.opaque = NO;
		web.backgroundColor = UIColor.clearColor;
		if ([web respondsToSelector:@selector(scrollView)]) {
			UIScrollView *sv = [(id)web scrollView];
			sv.opaque = NO;
			sv.backgroundColor = UIColor.clearColor;
		}
		g_view = v;

		g_mpv = mpv_create();
		if (!g_mpv) { rc = -3; return; }
		mpv_set_option_string(g_mpv, "vo", "libmpv");
		mpv_set_option_string(g_mpv, "ao", "audiounit");
		mpv_set_option_string(g_mpv, "hwdec", hwdec && *hwdec ? hwdec : "videotoolbox");
		mpv_set_option_string(g_mpv, "keep-open", "yes");
		mpv_set_option_string(g_mpv, "idle", "yes");
		mpv_set_option_string(g_mpv, "sub-auto", "no");
		mpv_set_option_string(g_mpv, "input-default-bindings", "no");
		mpv_set_option_string(g_mpv, "msg-level", "all=info");
		mpv_request_log_messages(g_mpv, "info");
		if (mpv_initialize(g_mpv) < 0) { rc = -4; return; }

		g_evq = dispatch_queue_create("peli.mpv.events", DISPATCH_QUEUE_SERIAL);
		mpv_observe_property(g_mpv, 0, "time-pos", MPV_FORMAT_DOUBLE);
		mpv_observe_property(g_mpv, 0, "duration", MPV_FORMAT_DOUBLE);
		mpv_observe_property(g_mpv, 0, "pause", MPV_FORMAT_FLAG);
		mpv_observe_property(g_mpv, 0, "core-idle", MPV_FORMAT_FLAG);
		mpv_observe_property(g_mpv, 0, "paused-for-cache", MPV_FORMAT_FLAG);
		mpv_observe_property(g_mpv, 0, "track-list", MPV_FORMAT_STRING);
		mpv_observe_property(g_mpv, 0, "aid", MPV_FORMAT_STRING);
		mpv_observe_property(g_mpv, 0, "sid", MPV_FORMAT_STRING);
		mpv_observe_property(g_mpv, 0, "hwdec-current", MPV_FORMAT_STRING);
		mpv_observe_property(g_mpv, 0, "video-format", MPV_FORMAT_STRING);
		mpv_observe_property(g_mpv, 0, "audio-codec-name", MPV_FORMAT_STRING);
		mpv_set_wakeup_callback(g_mpv, wakeup, NULL);
	};
	if (NSThread.isMainThread) work(); else dispatch_sync(dispatch_get_main_queue(), work);
	if (rc) return rc;

	// The render context is created on the render queue, GL context current.
	dispatch_sync(g_view.rq, ^{
		[g_view setupGL];
		mpv_opengl_init_params init = {.get_proc_address = get_proc_address};
		int adv = 1;
		mpv_render_param params[] = {
			{MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL},
			{MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &init},
			{MPV_RENDER_PARAM_ADVANCED_CONTROL, &adv},
			{MPV_RENDER_PARAM_INVALID, NULL},
		};
		if (mpv_render_context_create(&g_rctx, g_mpv, params) < 0) { rc = -5; return; }
		mpv_render_context_set_update_callback(g_rctx, on_update, NULL);
	});
	if (rc) return rc;
	[g_view requestDraw];
	return 0;
}

int peli_command(const char **args) { return g_mpv ? mpv_command(g_mpv, args) : -1; }
int peli_set_property(const char *name, const char *value) {
	return g_mpv ? mpv_set_property_string(g_mpv, name, value) : -1;
}
char *peli_get_property(const char *name) {
	if (!g_mpv) return NULL;
	char *s = mpv_get_property_string(g_mpv, name);
	if (!s) return NULL;
	char *c = strdup(s);
	mpv_free(s);
	return c;
}
void peli_free(char *p) { free(p); }

char *peli_stats(void) {
	PeliVideoView *v = g_view;
	if (!v) return strdup("{}");
	long n = v.frameCount, us = v.renderMicros;
	__block CGSize pts = CGSizeZero;
	__block CGFloat scale = 1;
	dispatch_sync(dispatch_get_main_queue(), ^{ pts = v.bounds.size; scale = v.layer.contentsScale; });
	NSString *s = [NSString stringWithFormat:
		@"{\"frames\":%ld,\"avgRenderMs\":%.2f,\"drawableW\":%d,\"drawableH\":%d,\"viewW\":%.0f,\"viewH\":%.0f,\"scale\":%.0f}",
		n, n ? us / 1000.0 / n : 0.0, v.w, v.h, pts.width, pts.height, scale];
	return strdup(s.UTF8String);
}
