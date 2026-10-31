// The mini player on macOS (#70): the app window itself, made small, kept
// above other apps' windows and on every Space, over full-screen apps too,
// in the shape of the video. The video view and the webview follow the
// window's size, so nothing moves between windows. Runs on the main thread.
#import <Cocoa/Cocoa.h>

// The window as it was before, to put back.
static NSRect g_full_frame;
static NSWindowLevel g_full_level;
static NSWindowCollectionBehavior g_full_behavior;
static BOOL g_mini;
// Where the user last left the mini player in this run, to open there again.
static NSRect g_mini_frame;
static BOOL g_mini_moved;

static const CGFloat mini_width = 480, mini_margin = 16;

static void show_buttons(NSWindow *window, BOOL on) {
	for (NSWindowButton b = NSWindowCloseButton; b <= NSWindowZoomButton; b++)
		[window standardWindowButton:b].hidden = !on;
}

// The frame of a mini player of aspect (width / height) on visible: where
// it was last left, if that's still on this screen, or else the bottom
// right corner. Never more than a third of the screen wide.
static NSRect mini_frame(NSRect visible, double aspect) {
	CGFloat width = MIN(mini_width, visible.size.width / 3);
	if (g_mini_moved && NSContainsRect(visible, g_mini_frame))
		width = MIN(g_mini_frame.size.width, visible.size.width);
	CGFloat height = round(width / aspect);
	NSRect frame = NSMakeRect(NSMaxX(visible) - width - mini_margin, NSMinY(visible) + mini_margin,
	                          width, height);
	if (g_mini_moved && NSContainsRect(visible, g_mini_frame)) {
		// The same top-left corner, as the shape may have changed.
		frame.origin.x = g_mini_frame.origin.x;
		frame.origin.y = NSMaxY(g_mini_frame) - height;
		if (frame.origin.y < NSMinY(visible)) frame.origin.y = NSMinY(visible);
	}
	return frame;
}

void sinag_window_mini(void *win, int on, double aspect) {
	NSWindow *window = (__bridge NSWindow *)win;
	if (!on) {
		if (!g_mini) return;
		g_mini = NO;
		g_mini_frame = window.frame;
		g_mini_moved = YES;
		window.level = g_full_level;
		window.collectionBehavior = g_full_behavior;
		// Setting resize increments clears the aspect ratio.
		window.contentResizeIncrements = NSMakeSize(1, 1);
		show_buttons(window, YES);
		[window setFrame:g_full_frame display:YES animate:YES];
		return;
	}
	if (g_mini) return;
	if (!(aspect > 0)) aspect = 16.0 / 9.0;
	g_mini = YES;
	g_full_frame = window.frame;
	g_full_level = window.level;
	g_full_behavior = window.collectionBehavior;
	NSScreen *screen = window.screen ?: NSScreen.mainScreen;
	window.level = NSFloatingWindowLevel;
	window.collectionBehavior =
	    (g_full_behavior & ~(NSWindowCollectionBehaviorMoveToActiveSpace |
	                         NSWindowCollectionBehaviorFullScreenPrimary)) |
	    NSWindowCollectionBehaviorCanJoinAllSpaces | NSWindowCollectionBehaviorFullScreenAuxiliary;
	// The traffic lights would sit on the video, and close would quit.
	show_buttons(window, NO);
	window.contentAspectRatio = NSMakeSize(aspect, 1);
	[window setFrame:mini_frame(screen.visibleFrame, aspect) display:YES animate:YES];
}
