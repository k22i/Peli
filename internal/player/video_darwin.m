//go:build darwin && !ios

// macOS video host (ADR-0002): an NSView inserted below Wails' WKWebView in
// the window's content view, backed by a CAOpenGLLayer that mpv renders into.
// Every draw runs on our own serial queue, never the main thread: mpv's
// render call blocks until the frame's display time, which froze the main
// thread ~14 ms a frame in M0 (#4), and our queue keeps drawing when the
// window is occluded. The transparent webview on top gets all input and
// draws the React UI; Core Animation composites the two.
#define GL_SILENCE_DEPRECATION
#import <Cocoa/Cocoa.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl3.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#include <dlfcn.h>
#include <pthread.h>
#include <mpv/render_gl.h>
#include <stdatomic.h>

#include "video.h"

static dispatch_queue_t g_queue;
static NSView *g_view;
static WKWebView *g_web;
static BOOL g_web_drew_background;
static mpv_render_context *g_rctx; // used on g_queue, under the CGL context lock
static atomic_int g_redraw_queued;
static id<NSObject> g_activity;
// g_link draws every vsync while motion smoothing is on: mpv's
// display-resample mode needs a render each refresh, not only when a new
// frame is due.
static CVDisplayLinkRef g_link;
// g_edr: the next layer gets a half-float back buffer, for HDR (#66).
static BOOL g_edr;
// g_sdr: the colourspace a half-float layer has for SDR, the screen's.
// Untagged, Core Animation reads half-float as linear, and SDR looks washed
// out; tagged with the screen's, it shows as the 8-bit layer does.
static CGColorSpaceRef g_sdr;

static void gl_dummy_flush(void) {}

static void *gl_proc(void *ctx, const char *name) {
	static void *lib;
	if (!lib) lib = dlopen("/System/Library/Frameworks/OpenGL.framework/OpenGL", RTLD_LAZY);
	// Like mpv's cocoa-cb: Core Animation flushes the layer itself, so an
	// extra glFlush from mpv mid-frame only costs time.
	if (strcmp(name, "glFlush") == 0) return (void *)gl_dummy_flush;
	return dlsym(lib, name);
}

// redraw has the layer draw on our queue. -[CAOpenGLLayer display] may run
// off the main thread inside an explicit transaction.
static void redraw(void) {
	if (atomic_exchange(&g_redraw_queued, 1)) return;
	NSView *view = [g_view retain];
	dispatch_async(g_queue, ^{
		atomic_store(&g_redraw_queued, 0);
		[CATransaction begin];
		[view.layer display];
		[CATransaction commit];
		[CATransaction flush];
		[view release];
	});
}

// on_update runs on an mpv thread whenever there's a frame to draw. It must
// not call into libmpv.
static void on_update(void *ctx) { redraw(); }

@interface PeliVideoLayer : CAOpenGLLayer {
@public
	CGLContextObj ctx;
	CGLPixelFormatObj pf;
	// floatFB: a half-float back buffer, so values above 1.0 (EDR) survive.
	BOOL floatFB;
}
@end

@implementation PeliVideoLayer
- (instancetype)init {
	if (!(self = [super init])) return nil;
	CGLPixelFormatAttribute attrs[] = {
		kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
		kCGLPFAAccelerated, kCGLPFADoubleBuffer, kCGLPFAAllowOfflineRenderers,
		kCGLPFAColorSize, (CGLPixelFormatAttribute)64, kCGLPFAColorFloat, 0,
	};
	GLint npix = 0;
	// Like mpv's cocoa-cb. Without EDR, or if the GPU has no such format,
	// the default 8-bit one.
	if (g_edr && CGLChoosePixelFormat(attrs, &pf, &npix) == kCGLNoError && pf) {
		floatFB = YES;
	} else {
		attrs[5] = 0;
		if (CGLChoosePixelFormat(attrs, &pf, &npix) != kCGLNoError || !pf) return self;
	}
	CGLCreateContext(pf, NULL, &ctx);
	if (floatFB) self.contentsFormat = kCAContentsFormatRGBA16Float;
	// Only our queue draws: a resize asks it to (setBounds), rather than
	// having Core Animation draw on the main thread.
	self.asynchronous = NO;
	self.needsDisplayOnBoundsChange = NO;
	self.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
	return self;
}

- (void)dealloc {
	if (ctx) CGLReleaseContext(ctx);
	if (pf) CGLReleasePixelFormat(pf);
	[super dealloc];
}

- (CGLPixelFormatObj)copyCGLPixelFormatForDisplayMask:(uint32_t)mask {
	return CGLRetainPixelFormat(pf);
}

- (CGLContextObj)copyCGLContextForPixelFormat:(CGLPixelFormatObj)p {
	return CGLRetainContext(ctx);
}

- (void)setBounds:(CGRect)b {
	[super setBounds:b];
	if (g_view) redraw(); // at the new size, even when paused
}

- (void)drawInCGLContext:(CGLContextObj)c pixelFormat:(CGLPixelFormatObj)p
	forLayerTime:(CFTimeInterval)t displayTime:(const CVTimeStamp *)ts {
	CGLLockContext(c);
	if (!g_rctx || pthread_main_np()) {
		// Nothing to render yet, or Core Animation asked on the main thread
		// anyway: black now, mpv's frame from our queue next.
		glClearColor(0, 0, 0, 1);
		glClear(GL_COLOR_BUFFER_BIT);
		[super drawInCGLContext:c pixelFormat:p forLayerTime:t displayTime:ts];
		CGLUnlockContext(c);
		if (g_rctx) redraw();
		return;
	}
	GLint vp[4], fbo = 0;
	glGetIntegerv(GL_VIEWPORT, vp);
	glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &fbo);
	mpv_opengl_fbo target = {.fbo = fbo, .w = vp[2], .h = vp[3], .internal_format = floatFB ? GL_RGBA16F : 0};
	int flip = 1, depth = floatFB ? 16 : 8;
	mpv_render_param params[] = {
		{MPV_RENDER_PARAM_OPENGL_FBO, &target},
		{MPV_RENDER_PARAM_FLIP_Y, &flip},
		{MPV_RENDER_PARAM_DEPTH, &depth},
		{0},
	};
	mpv_render_context_render(g_rctx, params);
	[super drawInCGLContext:c pixelFormat:p forLayerTime:t displayTime:ts];
	mpv_render_context_report_swap(g_rctx);
	CGLUnlockContext(c);
}
@end

@interface PeliVideoView : NSView
@end

@implementation PeliVideoView
- (CALayer *)makeBackingLayer {
	return [[[PeliVideoLayer alloc] init] autorelease];
}

// The webview above takes all input; never let the video view be hit.
- (NSView *)hitTest:(NSPoint)p {
	return nil;
}

// Moving to a display with another scale: render at its pixel size.
- (void)viewDidChangeBackingProperties {
	[super viewDidChangeBackingProperties];
	if (self.window) self.layer.contentsScale = self.window.backingScaleFactor;
	redraw();
}
@end

static WKWebView *find_webview(NSView *v) {
	if ([v isKindOfClass:[WKWebView class]]) return (WKWebView *)v;
	for (NSView *s in v.subviews) {
		WKWebView *w = find_webview(s);
		if (w) return w;
	}
	return nil;
}

int peli_video_attach(void *win, char *err, int errlen) {
	NSWindow *window = (__bridge NSWindow *)win;
	WKWebView *web = find_webview(window.contentView);
	if (!web) {
		snprintf(err, errlen, "no WKWebView in the window");
		return -1;
	}
	if (!g_queue) g_queue = dispatch_queue_create("peli.player.render", DISPATCH_QUEUE_SERIAL);
	// The screen can show more than SDR white: an XDR display, or HDR on
	// for it in System Settings. Decided per session, as the layer is made.
	NSScreen *screen = window.screen ?: NSScreen.mainScreen;
	g_edr = screen.maximumPotentialExtendedDynamicRangeColorComponentValue > 1.0;
	PeliVideoView *view = [[PeliVideoView alloc] initWithFrame:web.frame];
	view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
	view.layerContentsRedrawPolicy = NSViewLayerContentsRedrawNever;
	view.wantsLayer = YES;
	PeliVideoLayer *layer = (PeliVideoLayer *)view.layer;
	if (![layer isKindOfClass:[PeliVideoLayer class]] || !layer->ctx) {
		[view release];
		snprintf(err, errlen, "no OpenGL context for the video layer");
		return -1;
	}
	layer.contentsScale = window.backingScaleFactor;
	CGColorSpaceRelease(g_sdr);
	g_sdr = layer->floatFB ? CGColorSpaceRetain(screen.colorSpace.CGColorSpace) : NULL;
	layer.colorspace = g_sdr;
	[web.superview addSubview:view positioned:NSWindowBelow relativeTo:web];
	g_view = view;
	// The webview must not paint its own background over the video. Wails
	// beta.28 leaves drawsBackground on (M0, #4); same private key it uses.
	g_web = [web retain];
	g_web_drew_background = [[web valueForKey:@"drawsBackground"] boolValue];
	[web setValue:@NO forKey:@"drawsBackground"];
	return 0;
}

int peli_video_start(mpv_handle *mpv, char *err, int errlen) {
	__block int rc = 0;
	PeliVideoLayer *layer = (PeliVideoLayer *)g_view.layer;
	dispatch_sync(g_queue, ^{
		CGLLockContext(layer->ctx);
		CGLSetCurrentContext(layer->ctx);
		mpv_opengl_init_params gl = {.get_proc_address = gl_proc};
		mpv_render_param params[] = {
			{MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL},
			{MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl},
			{0},
		};
		rc = mpv_render_context_create(&g_rctx, mpv, params);
		if (rc >= 0) mpv_render_context_set_update_callback(g_rctx, on_update, NULL);
		CGLSetCurrentContext(NULL);
		CGLUnlockContext(layer->ctx);
	});
	if (rc < 0) {
		g_rctx = NULL;
		snprintf(err, errlen, "mpv_render_context_create: %s", mpv_error_string(rc));
		return -1;
	}
	return 0;
}

static void stop_link(void) {
	@synchronized([NSProcessInfo class]) {
		if (!g_link) return;
		CVDisplayLinkStop(g_link);
		CVDisplayLinkRelease(g_link);
		g_link = NULL;
	}
}

static CVReturn on_vsync(CVDisplayLinkRef link, const CVTimeStamp *now, const CVTimeStamp *out,
                         CVOptionFlags flags, CVOptionFlags *flagsOut, void *ctx) {
	redraw();
	return kCVReturnSuccess;
}

// peli_video_smooth starts or stops drawing every vsync of the layer's
// display, and returns that display's refresh rate (0 if unknown or off),
// for mpv's display-fps-override: the render API can't see the display.
// Any thread.
double peli_video_smooth(int on) {
	if (!on || !g_view) {
		stop_link();
		return 0;
	}
	PeliVideoLayer *layer = (PeliVideoLayer *)g_view.layer;
	@synchronized([NSProcessInfo class]) {
		if (!g_link) {
			if (CVDisplayLinkCreateWithActiveCGDisplays(&g_link) != kCVReturnSuccess) {
				g_link = NULL;
				return 0;
			}
			CVDisplayLinkSetCurrentCGDisplayFromOpenGLContext(g_link, layer->ctx, layer->pf);
			CVDisplayLinkSetOutputCallback(g_link, on_vsync, NULL);
			CVDisplayLinkStart(g_link);
		}
		CVTime period = CVDisplayLinkGetNominalOutputVideoRefreshPeriod(g_link);
		if ((period.flags & kCVTimeIsIndefinite) || period.timeValue == 0) return 0;
		return (double)period.timeScale / (double)period.timeValue;
	}
}

void peli_video_stop(void) {
	stop_link();
	if (!g_view) return;
	PeliVideoLayer *layer = (PeliVideoLayer *)g_view.layer;
	dispatch_sync(g_queue, ^{
		if (!g_rctx) return;
		CGLLockContext(layer->ctx);
		CGLSetCurrentContext(layer->ctx);
		mpv_render_context_free(g_rctx);
		g_rctx = NULL;
		CGLSetCurrentContext(NULL);
		CGLUnlockContext(layer->ctx);
	});
}

void peli_video_detach(void) {
	if (!g_view) return;
	[g_view removeFromSuperview];
	[g_web setValue:@(g_web_drew_background) forKey:@"drawsBackground"];
	[g_web release];
	g_web = nil;
	// Draws already queued hold their own reference.
	[g_view release];
	g_view = nil;
}

int peli_video_can_show_hdr(void) {
	return g_view && ((PeliVideoLayer *)g_view.layer)->floatFB;
}

// peli_video_show_hdr tags the layer BT.2100 PQ, which mpv then renders,
// and has Core Animation show it as EDR: macOS maps it to the headroom the
// display has. Off, it's SDR in the screen's colourspace again. On the UI
// thread.
void peli_video_show_hdr(int on) {
	if (!g_view) return;
	PeliVideoLayer *layer = (PeliVideoLayer *)g_view.layer;
	CGColorSpaceRef cs = on ? CGColorSpaceCreateWithName(kCGColorSpaceITUR_2100_PQ) : CGColorSpaceRetain(g_sdr);
	layer.wantsExtendedDynamicRangeContent = on != 0;
	layer.colorspace = cs;
	CGColorSpaceRelease(cs);
	redraw();
}

// peli_video_playing holds an activity while video plays, so App Nap
// doesn't throttle us and the display doesn't sleep. Any thread.
void peli_video_playing(int on) {
	@synchronized([NSProcessInfo class]) {
		if (on && !g_activity) {
			g_activity = [[[NSProcessInfo processInfo]
				beginActivityWithOptions:NSActivityUserInitiated | NSActivityIdleDisplaySleepDisabled | NSActivityLatencyCritical
				reason:@"Playing video"] retain];
		} else if (!on && g_activity) {
			[[NSProcessInfo processInfo] endActivity:g_activity];
			[g_activity release];
			g_activity = nil;
		}
	}
}
