// macOS video host for the render API: an NSView inserted *below* Wails'
// WKWebView in the window's content view. In "gl" mode its backing layer is
// a CAOpenGLLayer that mpv renders into: by default on the main thread via
// setNeedsDisplay (as mpv's own cocoa-cb does), with SPIKE_GL_THREAD on our
// own serial queue (as IINA does), or with SPIKE_GL_ASYNC as an asynchronous
// layer. In "sw" mode a render thread draws into memory and the frames become
// the layer's contents. The transparent webview on top gets all input and
// draws the React UI; Core Animation composites the two.
#define GL_SILENCE_DEPRECATION
#import <Cocoa/Cocoa.h>
#import <OpenGL/OpenGL.h>
#import <OpenGL/gl3.h>
#import <QuartzCore/QuartzCore.h>
#import <WebKit/WebKit.h>
#include <dlfcn.h>
#include <mpv/render_gl.h>
#include <stdatomic.h>

#include "swrender.h"
#include "video.h"

static fstats g_fs = {.mu = PTHREAD_MUTEX_INITIALIZER};
static int g_mode, g_hdr; // g_hdr: 0 off, 1 PQ (BT.2100), 2 extended linear Display P3
static mpv_handle *g_mpv;
static mpv_render_context *g_rctx; // gl mode; used under the CGL context lock
static NSView *g_view;
static atomic_int g_ready, g_redraw_queued, g_readback, g_frame_pending, g_draw_thread;
static int g_async;  // SPIKE_GL_ASYNC: CAOpenGLLayer.asynchronous (CA polls canDraw every vsync)
static int g_thread; // SPIKE_GL_THREAD: draw on our own serial queue, like IINA
static dispatch_queue_t g_queue;
static atomic_long g_n_update, g_n_dispatch, g_n_candraw, g_n_draw; // debugging counters
static swr g_sw;
static char g_info[512], g_info2[128];

// --- gl mode ------------------------------------------------------------

static void gl_dummy_flush(void) {}

static void *gl_proc(void *ctx, const char *name) {
	static void *lib;
	if (!lib) lib = dlopen("/System/Library/Frameworks/OpenGL.framework/OpenGL", RTLD_LAZY);
	// Like mpv's cocoa-cb: Core Animation flushes the layer itself, so an
	// extra glFlush from mpv mid-frame only costs time.
	if (strcmp(name, "glFlush") == 0) return (void *)gl_dummy_flush;
	return dlsym(lib, name);
}

// on_update runs on an mpv thread whenever there's something to draw. It must
// not call into libmpv; it just schedules a redraw.
static void on_update(void *ctx) {
	atomic_fetch_add(&g_n_update, 1);
	if (g_async) {
		atomic_store(&g_frame_pending, 1);
		return;
	}
	if (atomic_exchange(&g_redraw_queued, 1)) return;
	if (g_thread) {
		// -[CAOpenGLLayer display] may run off the main thread inside an
		// explicit transaction; mpv's blocking render then waits here.
		dispatch_async(g_queue, ^{
			atomic_store(&g_redraw_queued, 0);
			atomic_fetch_add(&g_n_dispatch, 1);
			[CATransaction begin];
			[g_view.layer display];
			[CATransaction commit];
			[CATransaction flush];
		});
		return;
	}
	dispatch_async(dispatch_get_main_queue(), ^{
		atomic_store(&g_redraw_queued, 0);
		atomic_fetch_add(&g_n_dispatch, 1);
		[g_view.layer setNeedsDisplay];
	});
}

@interface SpikeGLLayer : CAOpenGLLayer {
@public
	CGLContextObj ctx;
	CGLPixelFormatObj pf;
	GLuint query;
	int queryPending, floatFB, block;
}
@end

@implementation SpikeGLLayer
- (instancetype)init {
	if (!(self = [super init])) return nil;
	CGLPixelFormatAttribute attrs[16] = {
		kCGLPFAOpenGLProfile, (CGLPixelFormatAttribute)kCGLOGLPVersion_3_2_Core,
		kCGLPFAAccelerated, kCGLPFADoubleBuffer, kCGLPFAAllowOfflineRenderers,
	};
	int n = 5;
	if (g_hdr) {
		// A half-float back buffer, so values above 1.0 (EDR) survive.
		attrs[n++] = kCGLPFAColorSize;
		attrs[n++] = (CGLPixelFormatAttribute)64;
		attrs[n++] = kCGLPFAColorFloat;
	}
	attrs[n] = 0;
	GLint npix = 0;
	if (CGLChoosePixelFormat(attrs, &pf, &npix) != kCGLNoError || !pf) {
		fs_note(&g_fs, "CGLChoosePixelFormat failed");
		return self;
	}
	CGLCreateContext(pf, NULL, &ctx);
	floatFB = g_hdr != 0;
	block = getenv("SPIKE_NO_BLOCK") == NULL;
	g_async = getenv("SPIKE_GL_ASYNC") != NULL;
	g_thread = getenv("SPIKE_GL_THREAD") != NULL;
	if (g_thread) g_queue = dispatch_queue_create("staysh.mpv.render", DISPATCH_QUEUE_SERIAL);
	self.asynchronous = g_async;
	self.needsDisplayOnBoundsChange = YES;
	self.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
	if (g_hdr) {
		self.contentsFormat = kCAContentsFormatRGBA16Float;
		self.wantsExtendedDynamicRangeContent = YES;
		CGColorSpaceRef cs = CGColorSpaceCreateWithName(
			g_hdr == 1 ? kCGColorSpaceITUR_2100_PQ : kCGColorSpaceExtendedLinearDisplayP3);
		self.colorspace = cs;
		CGColorSpaceRelease(cs);
	}

	CGLSetCurrentContext(ctx);
	mpv_opengl_init_params gl = {.get_proc_address = gl_proc};
	mpv_render_param params[] = {
		{MPV_RENDER_PARAM_API_TYPE, MPV_RENDER_API_TYPE_OPENGL},
		{MPV_RENDER_PARAM_OPENGL_INIT_PARAMS, &gl},
		{0},
	};
	if (mpv_render_context_create(&g_rctx, g_mpv, params) < 0) {
		fs_note(&g_fs, "mpv_render_context_create failed");
		atomic_store(&g_ready, -1);
		return self;
	}
	mpv_render_context_set_update_callback(g_rctx, on_update, NULL);
	glGenQueries(1, &query);
	snprintf(g_info, sizeof g_info, "CAOpenGLLayer (%s); GL_RENDERER=%s; GL_VERSION=%s; %s back buffer; render blocks for target time: %s",
		g_async ? "asynchronous" : g_thread ? "display on a serial queue" : "drawn on setNeedsDisplay", glGetString(GL_RENDERER), glGetString(GL_VERSION),
		floatFB ? "RGBA16F" : "RGBA8", block ? "yes" : "no");
	atomic_store(&g_ready, 1);
	return self;
}

- (CGLPixelFormatObj)copyCGLPixelFormatForDisplayMask:(uint32_t)mask {
	return CGLRetainPixelFormat(pf);
}

- (CGLContextObj)copyCGLContextForPixelFormat:(CGLPixelFormatObj)p {
	return CGLRetainContext(ctx);
}

- (BOOL)canDrawInCGLContext:(CGLContextObj)c pixelFormat:(CGLPixelFormatObj)p
	forLayerTime:(CFTimeInterval)t displayTime:(const CVTimeStamp *)ts {
	atomic_fetch_add(&g_n_candraw, 1);
	if (!g_async) return YES;
	return atomic_exchange(&g_frame_pending, 0);
}

- (void)setBounds:(CGRect)b {
	[super setBounds:b];
	atomic_store(&g_frame_pending, 1); // redraw at the new size even when paused
}

- (void)readback:(GLint)fbo width:(int)w height:(int)h {
	float *px = malloc((size_t)w * h * 4 * sizeof(float));
	glBindFramebuffer(GL_READ_FRAMEBUFFER, fbo);
	glReadPixels(0, 0, w, h, GL_RGBA, GL_FLOAT, px);
	// SDR reference white: 1.0 in extended linear, PQ(203 nits) in BT.2100 PQ.
	double white = g_hdr == 1 ? 0.5806 : 1.0, max = 0, sum = 0;
	long over = 0;
	for (long i = 0; i < (long)w * h; i++) {
		float m = fmaxf(px[i * 4], fmaxf(px[i * 4 + 1], px[i * 4 + 2]));
		if (m > max) max = m;
		sum += m;
		if (m > white + 0.01) over++;
	}
	free(px);
	pthread_mutex_lock(&g_fs.mu);
	g_fs.readback_done = 1;
	g_fs.rb_max = max;
	g_fs.rb_mean = sum / ((double)w * h);
	g_fs.rb_over_white = (double)over / ((double)w * h);
	pthread_mutex_unlock(&g_fs.mu);
}

- (void)drawInCGLContext:(CGLContextObj)c pixelFormat:(CGLPixelFormatObj)p
	forLayerTime:(CFTimeInterval)t displayTime:(const CVTimeStamp *)ts {
	CGLLockContext(c); // draws come from our queue and, on resize, from the main thread
	GLint vp[4];
	glGetIntegerv(GL_VIEWPORT, vp);
	atomic_store(&g_draw_thread, pthread_main_np() ? 1 : 2);
	atomic_fetch_add(&g_n_draw, 1);
	if (!g_rctx) {
		glClearColor(0, 0, 0, 1);
		glClear(GL_COLOR_BUFFER_BIT);
		[super drawInCGLContext:c pixelFormat:p forLayerTime:t displayTime:ts];
		CGLUnlockContext(c);
		return;
	}
	uint64_t flags = mpv_render_context_update(g_rctx);
	if (queryPending) {
		GLint avail = 0;
		glGetQueryObjectiv(query, GL_QUERY_RESULT_AVAILABLE, &avail);
		if (avail) {
			GLuint64 ns = 0;
			glGetQueryObjectui64v(query, GL_QUERY_RESULT, &ns);
			fs_gpu(&g_fs, ns / 1e6);
			queryPending = 0;
		}
	}
	GLint fbo = 0;
	glGetIntegerv(GL_DRAW_FRAMEBUFFER_BINDING, &fbo);
	mpv_opengl_fbo target = {.fbo = fbo, .w = vp[2], .h = vp[3], .internal_format = floatFB ? GL_RGBA16F : 0};
	int flip = 1, depth = floatFB ? 16 : 8;
	mpv_render_param params[] = {
		{MPV_RENDER_PARAM_OPENGL_FBO, &target},
		{MPV_RENDER_PARAM_FLIP_Y, &flip},
		{MPV_RENDER_PARAM_DEPTH, &depth},
		{MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME, &block},
		{0},
	};
	int timing = !queryPending;
	if (timing) glBeginQuery(GL_TIME_ELAPSED, query);
	int64_t t0 = fs_now();
	mpv_render_context_render(g_rctx, params);
	int64_t t1 = fs_now();
	if (timing) {
		glEndQuery(GL_TIME_ELAPSED);
		queryPending = 1;
	}
	fs_render(&g_fs, (flags & MPV_RENDER_UPDATE_FRAME) != 0, t0, t1, vp[2], vp[3]);
	if ((flags & MPV_RENDER_UPDATE_FRAME) && atomic_exchange(&g_readback, 0)) [self readback:fbo width:vp[2] height:vp[3]];
	[super drawInCGLContext:c pixelFormat:p forLayerTime:t displayTime:ts];
	mpv_render_context_report_swap(g_rctx);
	CGLUnlockContext(c);
}
@end

// --- sw mode ------------------------------------------------------------

static void sw_present(const void *px, int w, int h, size_t stride) {
	CFDataRef data = CFDataCreate(NULL, px, (CFIndex)(stride * h));
	CGDataProviderRef dp = CGDataProviderCreateWithCFData(data);
	CGColorSpaceRef cs = CGColorSpaceCreateWithName(kCGColorSpaceSRGB);
	CGImageRef img = CGImageCreate(w, h, 8, 32, stride, cs,
		kCGImageAlphaNoneSkipLast | kCGBitmapByteOrderDefault, dp, NULL, false, kCGRenderingIntentDefault);
	CGColorSpaceRelease(cs);
	CGDataProviderRelease(dp);
	CFRelease(data);
	dispatch_async(dispatch_get_main_queue(), ^{
		[CATransaction begin];
		[CATransaction setDisableActions:YES];
		g_view.layer.contents = (__bridge id)img;
		[CATransaction commit];
		CGImageRelease(img);
	});
}

// --- the view -----------------------------------------------------------

@interface SpikeVideoView : NSView
@end

@implementation SpikeVideoView
- (CALayer *)makeBackingLayer {
	if (g_mode == SPIKE_MODE_GL) return [[[SpikeGLLayer alloc] init] autorelease];
	CALayer *l = [CALayer layer];
	l.backgroundColor = CGColorGetConstantColor(kCGColorBlack);
	l.contentsGravity = kCAGravityResize;
	return l;
}

// The webview above takes all input; never let the video view be hit.
- (NSView *)hitTest:(NSPoint)p {
	return nil;
}

- (void)setFrameSize:(NSSize)size {
	[super setFrameSize:size];
	if (g_mode == SPIKE_MODE_SW && g_sw.mpv) {
		CGFloat s = self.window ? self.window.backingScaleFactor : 1;
		sw_resize(&g_sw, (int)(size.width * s), (int)(size.height * s));
	}
}
@end

static WKWebView *findWebView(NSView *v) {
	if ([v isKindOfClass:[WKWebView class]]) return (WKWebView *)v;
	for (NSView *s in v.subviews) {
		WKWebView *w = findWebView(s);
		if (w) return w;
	}
	return nil;
}

int spike_video_attach(void *win, mpv_handle *mpv, int mode, int hdr, char *err, int errlen) {
	NSWindow *window = (__bridge NSWindow *)win;
	WKWebView *web = findWebView(window.contentView);
	if (!web) {
		snprintf(err, errlen, "no WKWebView in the window");
		return -1;
	}
	g_mode = mode;
	g_hdr = hdr;
	g_mpv = mpv;
	// Runs launched from a terminal sometimes start behind it (cooperative
	// activation); an occluded window isn't drawn at all, which skews the bench.
	[NSApp activateIgnoringOtherApps:YES];
	[window makeKeyAndOrderFront:nil];
	NSView *host = web.superview;
	g_view = [[SpikeVideoView alloc] initWithFrame:web.frame];
	g_view.autoresizingMask = NSViewWidthSizable | NSViewHeightSizable;
	g_view.wantsLayer = YES; // creates the backing layer (and, in gl mode, the render context)
	[host addSubview:g_view positioned:NSWindowBelow relativeTo:web];
	if (getenv("SPIKE_DEBUG_HIDE_WEBVIEW")) web.hidden = YES;
	// Wails' MacBackdropTransparent should do this, but in beta.28 the
	// webview still had drawsBackground=YES by the time we got here (white
	// page over the video). Same private KVC key Wails uses.
	snprintf(g_info2, sizeof g_info2, "drawsBackground was %d", [[web valueForKey:@"drawsBackground"] intValue]);
	[web setValue:@NO forKey:@"drawsBackground"];
	if (mode == SPIKE_MODE_SW) {
		CGFloat s = window.backingScaleFactor;
		g_sw = (swr){.mpv = mpv, .fs = &g_fs, .present = sw_present,
			.want_w = (int)(web.frame.size.width * s), .want_h = (int)(web.frame.size.height * s)};
		snprintf(g_info, sizeof g_info, "CALayer contents from MPV_RENDER_API_TYPE_SW (rgb0) on a render thread");
		sw_start(&g_sw);
	}
	return 0;
}

int spike_video_ready(void) {
	if (g_mode == SPIKE_MODE_SW) return g_sw.ready;
	return atomic_load(&g_ready);
}

void spike_video_detach(void) {
	if (g_mode == SPIKE_MODE_SW) {
		if (g_sw.mpv) sw_stop(&g_sw);
		return;
	}
	SpikeGLLayer *l = (SpikeGLLayer *)g_view.layer;
	if (!g_rctx || ![l isKindOfClass:[SpikeGLLayer class]]) return;
	CGLLockContext(l->ctx);
	CGLSetCurrentContext(l->ctx);
	mpv_render_context_free(g_rctx);
	g_rctx = NULL;
	CGLUnlockContext(l->ctx);
}

void spike_video_stats(fstats *out, int reset) { fs_copy(&g_fs, out, reset); }

void spike_video_readback(void) { atomic_store(&g_readback, 1); }

const char *spike_video_info(void) { return g_info; }
int spike_video_draw_thread(void) { return atomic_load(&g_draw_thread); } // 1 main, 2 other
const char *spike_video_webview_note(void) { return g_info2; }

// spike_view_order reports where our view sits relative to the webview in
// their superview: 1 if it's directly below, 0 otherwise.
int spike_view_order(void) {
	NSArray *subs = g_view.superview.subviews;
	NSUInteger i = [subs indexOfObject:g_view];
	return i != NSNotFound && i + 1 < subs.count && [subs[i + 1] isKindOfClass:[WKWebView class]];
}

void spike_screen_edr(void *win, double *cur, double *potential, double *reference) {
	NSScreen *s = ((__bridge NSWindow *)win).screen ?: NSScreen.mainScreen;
	*cur = s.maximumExtendedDynamicRangeColorComponentValue;
	*potential = s.maximumPotentialExtendedDynamicRangeColorComponentValue;
	*reference = 0;
	if (@available(macOS 10.15, *)) *reference = s.maximumReferenceExtendedDynamicRangeColorComponentValue;
}

// --- input probes ---------------------------------------------------------
// Synthesised in-process and delivered through -[NSWindow sendEvent:], so
// they go through the same hit-testing as real input (no Accessibility
// permission needed). x/y are in webview points from the top-left; negative
// values count from the right/bottom edge, values in (0, 1) are fractions.

static NSPoint probePoint(NSWindow *w, WKWebView *web, double x, double y) {
	NSRect b = web.bounds;
	if (x > 0 && x < 1) x *= b.size.width;
	if (y > 0 && y < 1) y *= b.size.height;
	if (x < 0) x += b.size.width;
	if (y < 0) y += b.size.height;
	return [web convertPoint:NSMakePoint(x, y) toView:nil]; // WKWebView is flipped
}

// spike_inject_click returns the class of the view the window hit-tests at
// that point (it must be the webview's, never the video view).
const char *spike_inject_click(void *win, double x, double y) {
	NSWindow *w = (__bridge NSWindow *)win;
	WKWebView *web = findWebView(w.contentView);
	[NSApp activateIgnoringOtherApps:YES];
	[w makeKeyAndOrderFront:nil];
	NSPoint p = probePoint(w, web, x, y);
	NSView *hit = [w.contentView.superview hitTest:p];
	NSEventType types[2] = {NSEventTypeLeftMouseDown, NSEventTypeLeftMouseUp};
	for (int i = 0; i < 2; i++) {
		NSEvent *e = [NSEvent mouseEventWithType:types[i] location:p modifierFlags:0
			timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:w.windowNumber
			context:nil eventNumber:0 clickCount:1 pressure:1];
		[w sendEvent:e];
	}
	return hit ? object_getClassName(hit) : "nil";
}

void spike_inject_key(void *win, const char *chars, unsigned short code) {
	NSWindow *w = (__bridge NSWindow *)win;
	NSString *s = [NSString stringWithUTF8String:chars];
	NSEventType types[2] = {NSEventTypeKeyDown, NSEventTypeKeyUp};
	for (int i = 0; i < 2; i++) {
		NSEvent *e = [NSEvent keyEventWithType:types[i] location:NSZeroPoint modifierFlags:0
			timestamp:NSProcessInfo.processInfo.systemUptime windowNumber:w.windowNumber
			context:nil characters:s charactersIgnoringModifiers:s isARepeat:NO keyCode:code];
		[w sendEvent:e];
	}
}

// spike_window_state: bit 0 = occlusion state visible, bit 1 = app active,
// bit 2 = window is key.
int spike_window_state(void *win) {
	NSWindow *w = (__bridge NSWindow *)win;
	return ((w.occlusionState & NSWindowOcclusionStateVisible) ? 1 : 0) | (NSApp.isActive ? 2 : 0) | (w.isKeyWindow ? 4 : 0);
}

void spike_debug_counters(long *u, long *d, long *c, long *w) {
	*u = atomic_load(&g_n_update);
	*d = atomic_load(&g_n_dispatch);
	*c = atomic_load(&g_n_candraw);
	*w = atomic_load(&g_n_draw);
}
