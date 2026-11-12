//go:build ios

// The video host: libmpv's render API on OpenGL ES, drawn in a CAEAGLLayer
// view that sits BEHIND Wails' WKWebView (ADR-0055). The webview is made
// transparent while the host is attached, so the page's controls float over
// the picture. Productionised from spikes/ios-libmpv/mpvview_ios.m.
//
//   WailsViewController.view
//     ├─ PeliVideoView   (CAEAGLLayer)      ← inserted at index 0, full screen
//     └─ WKWebView       (clear background) ← Wails' own, inside the safe area

#define GLES_SILENCE_DEPRECATION 1
#import <UIKit/UIKit.h>
#import <AVFoundation/AVFoundation.h>
#import <MediaAccessibility/MediaAccessibility.h>
#import <OpenGLES/EAGL.h>
#import <OpenGLES/EAGLDrawable.h>
#import <OpenGLES/ES3/gl.h>
#import <QuartzCore/QuartzCore.h>
#include <dlfcn.h>
#include <stdatomic.h>
#include <mpv/client.h>
#include <mpv/render_gl.h>
#include "host_ios.h"

static mpv_render_context *g_rctx;

@interface PeliVideoView : UIView
@property(nonatomic, strong) EAGLContext *glctx;
@property(nonatomic, strong) dispatch_queue_t rq;
@property(nonatomic) GLuint fbo, rbo;
@property(nonatomic) GLint w, h;
- (void)requestDraw;
- (void)teardown;
@end

@implementation PeliVideoView {
	_Atomic int _needsResize, _pending, _background;
	id _bgObs, _fgObs;
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
	__weak PeliVideoView *weak = self;
	// GL work in the background is killed by the OS: park the renderer.
	_bgObs = [nc addObserverForName:UIApplicationDidEnterBackgroundNotification object:nil queue:nil
	                     usingBlock:^(NSNotification *n) {
		PeliVideoView *s = weak;
		if (!s) return;
		atomic_store(&s->_background, 1);
		dispatch_sync(s->_rq, ^{ glFinish(); });
	}];
	_fgObs = [nc addObserverForName:UIApplicationWillEnterForegroundNotification object:nil queue:nil
	                     usingBlock:^(NSNotification *n) {
		PeliVideoView *s = weak;
		if (!s) return;
		atomic_store(&s->_background, 0);
		[s requestDraw];
	}];
	return self;
}

- (void)layoutSubviews {
	[super layoutSubviews];
	((CAEAGLLayer *)self.layer).contentsScale = self.window.screen.scale ?: UIScreen.mainScreen.scale;
	atomic_store(&_needsResize, 1);
	[self requestDraw];
}

- (void)setupGL { // on rq
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

- (void)requestDraw {
	if (!g_rctx || atomic_exchange(&_pending, 1)) return;
	dispatch_async(_rq, ^{
		atomic_store(&self->_pending, 0);
		[self draw];
	});
}

- (void)draw { // on rq
	if (!g_rctx || atomic_load(&_background)) return;
	[EAGLContext setCurrentContext:_glctx];
	BOOL resized = atomic_exchange(&_needsResize, 0);
	if (resized) [self resizeGL];
	uint64_t flags = mpv_render_context_update(g_rctx);
	if (!resized && !(flags & MPV_RENDER_UPDATE_FRAME)) return;
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
}

- (void)teardown {
	NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
	if (_bgObs) [nc removeObserver:_bgObs];
	if (_fgObs) [nc removeObserver:_fgObs];
	_bgObs = _fgObs = nil;
}
@end

static PeliVideoView *g_view;
static UIView *g_web;
static BOOL g_webOpaque;
static UIColor *g_webBackground;
static UIColor *g_scrollBackground;
static BOOL g_scrollOpaque;
static UIColor *g_rootBackground;

static void *get_proc_address(void *ctx, const char *name) { return dlsym(RTLD_DEFAULT, name); }
static void on_update(void *ctx) { [g_view requestDraw]; }

int peli_host_attach(void *vcHandle, void *mpvHandle) {
	__block int rc = 0;
	void (^work)(void) = ^{
		UIViewController *vc = (__bridge UIViewController *)vcHandle;
		if (!vc || ![vc isKindOfClass:UIViewController.class]) { rc = -1; return; }
		UIView *root = vc.view;
		UIView *web = nil;
		@try { web = [vc valueForKey:@"webView"]; } @catch (NSException *e) {}
		if (!web) { rc = -2; return; }

		PeliVideoView *v = [[PeliVideoView alloc] initWithFrame:root.bounds];
		v.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
		g_rootBackground = root.backgroundColor;
		root.backgroundColor = UIColor.blackColor;
		[root insertSubview:v belowSubview:web];
		// A WKWebView is transparent only when neither it nor its scroll view
		// is opaque. Remember what Wails set, for detach.
		g_web = web;
		g_webOpaque = web.opaque;
		g_webBackground = web.backgroundColor;
		web.opaque = NO;
		web.backgroundColor = UIColor.clearColor;
		UIScrollView *sv = [web respondsToSelector:@selector(scrollView)] ? [(id)web scrollView] : nil;
		if (sv) {
			g_scrollOpaque = sv.opaque;
			g_scrollBackground = sv.backgroundColor;
			sv.opaque = NO;
			sv.backgroundColor = UIColor.clearColor;
		}
		g_view = v;
	};
	if (NSThread.isMainThread) work(); else dispatch_sync(dispatch_get_main_queue(), work);
	if (rc) return rc;

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
		if (mpv_render_context_create(&g_rctx, (mpv_handle *)mpvHandle, params) < 0) { rc = -3; return; }
		mpv_render_context_set_update_callback(g_rctx, on_update, NULL);
	});
	if (rc) { peli_host_detach(); return rc; }
	[g_view requestDraw];
	return 0;
}

void peli_host_detach(void) {
	PeliVideoView *v = g_view;
	if (!v) return;
	// The render context goes first, on the render queue that draws with it.
	dispatch_sync(v.rq, ^{
		if (g_rctx) {
			mpv_render_context_set_update_callback(g_rctx, NULL, NULL);
			[EAGLContext setCurrentContext:v.glctx];
			mpv_render_context_free(g_rctx);
			g_rctx = NULL;
		}
		glFinish();
		[EAGLContext setCurrentContext:nil];
	});
	void (^work)(void) = ^{
		[v teardown];
		[v removeFromSuperview];
		if (g_web) {
			g_web.opaque = g_webOpaque;
			g_web.backgroundColor = g_webBackground;
			UIScrollView *sv = [g_web respondsToSelector:@selector(scrollView)] ? [(id)g_web scrollView] : nil;
			if (sv) { sv.opaque = g_scrollOpaque; sv.backgroundColor = g_scrollBackground; }
		}
		g_web = nil;
		g_view = nil;
	};
	if (NSThread.isMainThread) work(); else dispatch_sync(dispatch_get_main_queue(), work);
}

void peli_host_awake(int on) {
	dispatch_async(dispatch_get_main_queue(), ^{
		UIApplication.sharedApplication.idleTimerDisabled = on ? YES : NO;
	});
}

int peli_audio_session(void) {
	AVAudioSession *s = AVAudioSession.sharedInstance;
	NSError *err = nil;
	// .playback: sound even with the silent switch on, and AirPlay and
	// Bluetooth routes; no mixing, so another app's audio gives way.
	if (![s setCategory:AVAudioSessionCategoryPlayback mode:AVAudioSessionModeMoviePlayback options:0 error:&err]) return -1;
	if (![s setActive:YES error:&err]) return -2;
	return 0;
}

int peli_system_captions(void) {
	if (MACaptionAppearanceGetDisplayType(kMACaptionAppearanceDomainUser) == kMACaptionAppearanceDisplayTypeAlwaysOn)
		return 1;
	CFArrayRef prefs = MACaptionAppearanceCopyPreferredCaptioningMediaCharacteristics(kMACaptionAppearanceDomainUser);
	if (prefs == NULL) return 0;
	int on = CFArrayContainsValue(prefs, CFRangeMake(0, CFArrayGetCount(prefs)),
		CFSTR("public.accessibility.transcribes-spoken-dialog"));
	CFRelease(prefs);
	return on;
}
