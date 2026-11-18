//go:build ios

// The floating Liquid Glass tab bar (#129): a capsule of tabs and a round
// Search button, native views over Wails' webview, so the real glass
// (UIGlassEffect, iOS 26) lenses the page scrolling under it. The frontend
// owns the state (shell.TabBarState, sent as JSON); taps go back as events.
//
// Not Wails' EnableNativeTabs UITabBar: that one lays the webview out above
// itself, so nothing scrolls under it, and it can't float or minimise.
//
// Geometry (iPhone 402 pt wide):
//   upright   capsule 62 high, 16 from the left safe edge, its bottom
//             max(safe bottom - 12, 8) above the screen's; Search a 62 circle
//             8 to its right, 16 from the right safe edge
//   on side   (height < 500, as the frontend's ios-short) 52 high, labels
//             beside the icons, the pair centred and at most 560 wide
//   minimised the capsule is a 48 circle with the current tab's icon
#import <UIKit/UIKit.h>
#import <WebKit/WebKit.h>

#include "tabbar_ios.h"

static const CGFloat kHeight = 62, kHeightShort = 52, kMini = 48;
static const CGFloat kEdge = 16, kGap = 8, kMaxShortWidth = 560;
static const NSTimeInterval kSpring = 0.35;
static const CGFloat kDamping = 0.8;

static BOOL shortScreen(CGSize size) { return size.height < 500; }

// Peli's sun-ink: the selected tab's icon and label (index.css).
static UIColor *sunInk(void) {
	return [UIColor colorWithRed:1 green:0xc4 / 255.0 blue:0x6b / 255.0 alpha:1];
}

API_AVAILABLE(ios(26.0))
static UIVisualEffectView *glassView(BOOL interactive) {
	UIGlassEffect *glass = [UIGlassEffect effectWithStyle:UIGlassEffectStyleRegular];
	glass.interactive = interactive;
	UIVisualEffectView *v = [[UIVisualEffectView alloc] initWithEffect:glass];
	v.cornerConfiguration = [UICornerConfiguration capsuleConfiguration];
	return v;
}

// One tab: an icon over (or, on its side, beside) a label.
@interface PeliTab : UIControl
@property (nonatomic, copy) NSString *tabID;
@property (nonatomic, strong) UIImageView *icon;
@property (nonatomic, strong) UILabel *label;
@property (nonatomic) BOOL beside;
@end

@implementation PeliTab
- (instancetype)initWithID:(NSString *)tabID label:(NSString *)label icon:(NSString *)icon {
	if (!(self = [super initWithFrame:CGRectZero])) return nil;
	_tabID = [tabID copy];
	UIImage *image = [[UIImage imageNamed:icon] imageWithRenderingMode:UIImageRenderingModeAlwaysTemplate];
	_icon = [[UIImageView alloc] initWithImage:image];
	_icon.contentMode = UIViewContentModeScaleAspectFit;
	_label = [UILabel new];
	_label.text = label;
	_label.font = [UIFont systemFontOfSize:10 weight:UIFontWeightSemibold];
	_label.textAlignment = NSTextAlignmentCenter;
	_label.adjustsFontSizeToFitWidth = YES;
	_label.minimumScaleFactor = 0.8;
	[self addSubview:_icon];
	[self addSubview:_label];
	self.isAccessibilityElement = YES;
	self.accessibilityLabel = label;
	// Tab bars don't grow with Dynamic Type; a long press shows the item big.
	self.showsLargeContentViewer = YES;
	self.largeContentTitle = label;
	self.largeContentImage = image;
	self.scalesLargeContentImage = YES;
	return self;
}

- (UIAccessibilityTraits)accessibilityTraits {
	return UIAccessibilityTraitButton | (self.selected ? UIAccessibilityTraitSelected : 0);
}

- (void)setSelected:(BOOL)selected {
	[super setSelected:selected];
	UIColor *colour = selected ? sunInk() : UIColor.labelColor;
	self.icon.tintColor = colour;
	self.label.textColor = colour;
}

- (void)layoutSubviews {
	[super layoutSubviews];
	CGSize s = self.bounds.size;
	const CGFloat i = 24;
	if (self.label.hidden) {
		self.icon.frame = CGRectMake((s.width - i) / 2, (s.height - i) / 2, i, i);
	} else if (self.beside) {
		CGSize l = [self.label sizeThatFits:CGSizeMake(s.width - i - 6, s.height)];
		CGFloat w = MIN(i + 6 + l.width, s.width);
		CGFloat x = (s.width - w) / 2;
		self.icon.frame = CGRectMake(x, (s.height - i) / 2, i, i);
		self.label.frame = CGRectMake(x + i + 6, 0, w - i - 6, s.height);
	} else {
		CGFloat top = (s.height - i - 2 - 12) / 2;
		self.icon.frame = CGRectMake((s.width - i) / 2, top, i, i);
		self.label.frame = CGRectMake(2, top + i + 2, s.width - 4, 12);
	}
}
@end

// The bar fills the view controller's view but only takes touches on the
// capsule and the Search circle: everything else reaches the webview.
API_AVAILABLE(ios(26.0))
@interface PeliTabBar : UIView
@property (nonatomic, strong) UIVisualEffectView *container;
@property (nonatomic, strong) UIVisualEffectView *capsule;
@property (nonatomic, strong) UIVisualEffectView *pill;
@property (nonatomic, strong) UIVisualEffectView *search;
@property (nonatomic, strong) UIControl *expand;
@property (nonatomic, strong) NSArray<PeliTab *> *tabs;
@property (nonatomic, copy) NSString *itemsKey;
@property (nonatomic, copy) NSString *active;
@property (nonatomic) BOOL hiddenByPage, minimized, keyboard, showSearch, built;
@end

@implementation PeliTabBar
- (instancetype)initWithFrame:(CGRect)frame {
	if (!(self = [super initWithFrame:frame])) return nil;
	self.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
	self.backgroundColor = UIColor.clearColor;

	// The capsule and the circle merge when they get close, as one glass.
	UIGlassContainerEffect *merge = [UIGlassContainerEffect new];
	merge.spacing = kGap;
	_container = [[UIVisualEffectView alloc] initWithEffect:merge];
	[self addSubview:_container];

	_capsule = glassView(YES);
	[_container.contentView addSubview:_capsule];
	// The selection: a glass lens behind the current tab.
	_pill = glassView(YES);
	_pill.userInteractionEnabled = NO;
	[_capsule.contentView addSubview:_pill];

	_search = glassView(YES);
	UIButton *searchButton = [UIButton buttonWithType:UIButtonTypeSystem];
	UIImage *glyph = [[UIImage imageNamed:@"TabSearch"] imageWithRenderingMode:UIImageRenderingModeAlwaysTemplate];
	[searchButton setImage:glyph forState:UIControlStateNormal];
	searchButton.tintColor = UIColor.labelColor;
	searchButton.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleHeight;
	searchButton.accessibilityLabel = @"Search";
	searchButton.showsLargeContentViewer = YES;
	searchButton.largeContentTitle = @"Search";
	searchButton.largeContentImage = glyph;
	[searchButton addTarget:self action:@selector(tapSearch) forControlEvents:UIControlEventTouchUpInside];
	[_search.contentView addSubview:searchButton];
	[_container.contentView addSubview:_search];

	// Over the minimised circle: one tap grows it back.
	_expand = [UIControl new];
	_expand.isAccessibilityElement = NO;
	[_expand addTarget:self action:@selector(tapExpand) forControlEvents:UIControlEventTouchUpInside];
	[_capsule.contentView addSubview:_expand];

	[self addInteraction:[UILargeContentViewerInteraction new]];

	NSNotificationCenter *nc = NSNotificationCenter.defaultCenter;
	[nc addObserver:self selector:@selector(keyboardUp:) name:UIKeyboardWillShowNotification object:nil];
	[nc addObserver:self selector:@selector(keyboardDown:) name:UIKeyboardWillHideNotification object:nil];
	return self;
}

- (void)dealloc {
	[NSNotificationCenter.defaultCenter removeObserver:self];
}

- (void)keyboardUp:(NSNotification *)n {
	if (self.keyboard) return;
	self.keyboard = YES;
	[self relayout:YES];
}

- (void)keyboardDown:(NSNotification *)n {
	if (!self.keyboard) return;
	self.keyboard = NO;
	[self relayout:YES];
}

- (void)tapTab:(PeliTab *)tab {
	// The pill moves at once; the frontend's next state confirms it.
	if (![tab.tabID isEqualToString:self.active]) {
		self.active = tab.tabID;
		[self relayout:YES];
	}
	peliShellTab((char *)tab.tabID.UTF8String);
}

- (void)tapSearch {
	// The Search page focuses its field when it opens; let that one focus
	// bring the keyboard up (focus_ios.m). Long enough for the route to load
	// on a slow phone; the window closes at the first focus.
	peli_focus_allow_keyboard(1.5);
	peliShellSearch();
}

- (void)tapExpand {
	if (!self.minimized) return;
	self.minimized = NO;
	[self relayout:YES];
	peliShellExpand();
}

- (BOOL)gone {
	return self.hiddenByPage || self.keyboard;
}

// Only the glass takes touches.
- (BOOL)pointInside:(CGPoint)point withEvent:(UIEvent *)event {
	if (self.gone) return NO;
	CGPoint inContainer = [self convertPoint:point toView:self.container];
	if (CGRectContainsPoint(self.capsule.frame, inContainer)) return YES;
	return !self.search.hidden && CGRectContainsPoint(self.search.frame, inContainer);
}

- (NSArray *)accessibilityElements {
	if (self.gone) return @[];
	NSMutableArray *list = [NSMutableArray array];
	for (PeliTab *tab in self.tabs) {
		if (!tab.hidden) [list addObject:tab];
	}
	if (!self.search.hidden) [list addObject:self.search.contentView.subviews.firstObject];
	return list;
}

- (void)apply:(NSDictionary *)state {
	NSArray *items = [state[@"items"] isKindOfClass:NSArray.class] ? state[@"items"] : @[];
	NSMutableString *key = [NSMutableString string];
	for (NSDictionary *item in items) {
		[key appendFormat:@"%@|%@|%@;", item[@"id"], item[@"label"], item[@"icon"]];
	}
	if (![key isEqualToString:self.itemsKey ?: @""] || !self.tabs) {
		for (PeliTab *tab in self.tabs) [tab removeFromSuperview];
		NSMutableArray *tabs = [NSMutableArray array];
		for (NSDictionary *item in items) {
			PeliTab *tab = [[PeliTab alloc] initWithID:[item[@"id"] description]
			                                     label:[item[@"label"] description]
			                                      icon:[item[@"icon"] description]];
			[tab addTarget:self action:@selector(tapTab:) forControlEvents:UIControlEventTouchUpInside];
			[self.capsule.contentView insertSubview:tab belowSubview:self.expand];
			[tabs addObject:tab];
		}
		self.tabs = tabs;
		self.itemsKey = key;
	}
	NSString *active = [state[@"active"] isKindOfClass:NSString.class] ? state[@"active"] : @"";
	BOOL hidden = [state[@"hidden"] boolValue];
	BOOL minimized = [state[@"minimized"] boolValue];
	BOOL search = [state[@"search"] boolValue];
	// Peli is dark only (#143): the bar is dark whatever iOS is set to. Over
	// the near-black page the clear glass reads as grey on a white poster, so a
	// little dark tint keeps the labels legible.
	if (self.overrideUserInterfaceStyle != UIUserInterfaceStyleDark) {
		self.overrideUserInterfaceStyle = UIUserInterfaceStyleDark;
		UIColor *tint = [UIColor colorWithWhite:0 alpha:0.18];
		for (UIVisualEffectView *v in @[ self.capsule, self.search ]) {
			UIGlassEffect *glass = [UIGlassEffect effectWithStyle:UIGlassEffectStyleRegular];
			glass.interactive = YES;
			glass.tintColor = tint;
			v.effect = glass;
		}
	}

	BOOL changed = !self.built || hidden != self.hiddenByPage || minimized != self.minimized ||
		search != self.showSearch || ![active isEqualToString:self.active ?: @""];
	self.hiddenByPage = hidden;
	self.minimized = minimized;
	self.showSearch = search;
	self.active = active;
	if (changed || !self.built) [self relayout:self.built];
	self.built = YES;
}

- (void)layoutSubviews {
	[super layoutSubviews];
	[self place];
}

- (void)relayout:(BOOL)animated {
	if (!animated || UIAccessibilityIsReduceMotionEnabled()) {
		[UIView performWithoutAnimation:^{ [self place]; }];
		return;
	}
	[UIView animateWithDuration:kSpring delay:0 usingSpringWithDamping:kDamping initialSpringVelocity:0
	                    options:UIViewAnimationOptionBeginFromCurrentState | UIViewAnimationOptionAllowUserInteraction
	                 animations:^{ [self place]; } completion:nil];
}

// The frames for the current state; animated by relayout.
- (void)place {
	CGSize size = self.bounds.size;
	if (size.width <= 0) return;
	UIEdgeInsets safe = self.safeAreaInsets;
	BOOL side = shortScreen(size);
	CGFloat h = side ? kHeightShort : kHeight;
	CGFloat bottom = MAX(safe.bottom - 12, 8);

	CGFloat left = safe.left + kEdge, right = size.width - safe.right - kEdge;
	if (side && right - left > kMaxShortWidth) {
		CGFloat mid = (left + right) / 2;
		left = mid - kMaxShortWidth / 2;
		right = mid + kMaxShortWidth / 2;
	}
	CGFloat searchW = self.showSearch ? h : 0;
	CGFloat capsuleW = right - left - (self.showSearch ? kGap + searchW : 0);

	// The whole row, in the container: it slides below the screen when gone.
	CGFloat y = size.height - bottom - h;
	CGFloat drop = self.gone ? h + bottom + 24 : 0;
	self.container.frame = CGRectMake(0, y + drop, size.width, h);
	self.container.alpha = self.gone ? 0 : 1;

	self.search.hidden = !self.showSearch;
	self.search.frame = CGRectMake(right - searchW, 0, searchW, h);
	UIView *searchButton = self.search.contentView.subviews.firstObject;
	searchButton.frame = self.search.contentView.bounds;
	// On Search itself, the circle is the selected item.
	BOOL onSearch = [self.active isEqualToString:@"/search"];
	searchButton.tintColor = onSearch ? sunInk() : UIColor.labelColor;
	searchButton.accessibilityTraits = UIAccessibilityTraitButton | (onSearch ? UIAccessibilityTraitSelected : 0);

	PeliTab *current = nil;
	for (PeliTab *tab in self.tabs) {
		if ([tab.tabID isEqualToString:self.active]) current = tab;
	}
	BOOL mini = self.minimized && current != nil;
	self.expand.hidden = !mini;
	if (mini) {
		CGFloat d = kMini;
		self.capsule.frame = CGRectMake(left, (h - d) / 2, d, d);
		self.expand.frame = CGRectMake(0, 0, d, d);
		for (PeliTab *tab in self.tabs) {
			BOOL shown = tab == current;
			tab.alpha = shown ? 1 : 0;
			tab.hidden = !shown;
			tab.label.hidden = YES;
			tab.frame = CGRectMake(0, 0, d, d);
			[tab setNeedsLayout];
			[tab layoutIfNeeded];
		}
		current.accessibilityHint = @"Shows the tab bar";
		self.pill.alpha = 0;
		self.pill.frame = CGRectMake(4, 4, d - 8, d - 8);
		return;
	}
	self.capsule.frame = CGRectMake(left, 0, MAX(capsuleW, h), h);
	NSUInteger n = MAX(self.tabs.count, 1);
	const CGFloat pad = 4;
	CGFloat w = (MAX(capsuleW, h) - pad * 2) / n;
	[self.tabs enumerateObjectsUsingBlock:^(PeliTab *tab, NSUInteger i, BOOL *stop) {
		tab.hidden = NO;
		tab.alpha = 1;
		tab.label.hidden = NO;
		tab.beside = side;
		tab.selected = tab == current;
		tab.accessibilityHint = nil;
		tab.frame = CGRectMake(pad + w * i, 0, w, h);
		[tab setNeedsLayout];
		[tab layoutIfNeeded];
	}];
	if (current) {
		self.pill.alpha = 1;
		self.pill.frame = CGRectInset(current.frame, 0, pad);
	} else {
		self.pill.alpha = 0;
	}
}

- (void)traitCollectionDidChange:(UITraitCollection *)previous {
	[super traitCollectionDidChange:previous];
	for (PeliTab *tab in self.tabs) tab.selected = tab.selected;
}
@end

static PeliTabBar *g_bar API_AVAILABLE(ios(26.0));

static void onMain(void (^work)(void)) {
	if (NSThread.isMainThread) work();
	else dispatch_sync(dispatch_get_main_queue(), work);
}

int peli_tabbar_set(void *vcHandle, const char *json) {
	if (@available(iOS 26.0, *)) {
	} else {
		return 1;
	}
	NSData *data = [NSData dataWithBytes:json length:strlen(json)];
	NSDictionary *state = [NSJSONSerialization JSONObjectWithData:data options:0 error:nil];
	if (![state isKindOfClass:NSDictionary.class]) return -3;
	__block int rc = 0;
	onMain(^{
		if (@available(iOS 26.0, *)) {
			UIViewController *vc = (__bridge UIViewController *)vcHandle;
			if (!vc || ![vc isKindOfClass:UIViewController.class]) { rc = -1; return; }
			UIView *web = nil;
			@try { web = [vc valueForKey:@"webView"]; } @catch (NSException *e) {}
			if (!web) { rc = -2; return; }
			if (!g_bar || g_bar.superview != vc.view) {
				[g_bar removeFromSuperview];
				g_bar = [[PeliTabBar alloc] initWithFrame:vc.view.bounds];
				[vc.view insertSubview:g_bar aboveSubview:web];
			}
			// Stay on top: the player puts its video under the webview, never
			// over, but keep the order right if anything else is added.
			[vc.view bringSubviewToFront:g_bar];
			[g_bar apply:state];
		}
	});
	return rc;
}

double peli_tabbar_height(void *vcHandle) {
	if (@available(iOS 26.0, *)) {
		__block double h = 0;
		onMain(^{
			UIViewController *vc = (__bridge UIViewController *)vcHandle;
			CGSize size = [vc isKindOfClass:UIViewController.class] ? vc.view.bounds.size : UIScreen.mainScreen.bounds.size;
			h = shortScreen(size) ? kHeightShort : kHeight;
		});
		return h;
	}
	return 0;
}

// The status-bar tap (#135). Pages scroll in the webview's #content, an
// overflow div, so UIKit's tap-to-top (which scrolls the one on-screen
// UIScrollView with scrollsToTop) did nothing. A 1 pt clear scroll view at
// the top of the controller's view is now that one: the webview's own
// scroll view opts out, and when UIKit asks ours whether to scroll, it says
// no and tells the frontend (shell:scroll-top), which scrolls #content.
@interface PeliStatusBarTap : UIScrollView <UIScrollViewDelegate>
@end

@implementation PeliStatusBarTap
- (instancetype)initWithFrame:(CGRect)frame {
	if ((self = [super initWithFrame:frame])) {
		self.backgroundColor = UIColor.clearColor;
		self.scrollsToTop = YES;
		self.showsVerticalScrollIndicator = NO;
		self.showsHorizontalScrollIndicator = NO;
		self.isAccessibilityElement = NO;
		self.delegate = self;
		self.autoresizingMask = UIViewAutoresizingFlexibleWidth | UIViewAutoresizingFlexibleBottomMargin;
		// Scrolled a little, so there is a "top" to go to: UIKit skips a
		// scroll view already there.
		self.contentSize = CGSizeMake(frame.size.width, 1000);
		self.contentOffset = CGPointMake(0, 1);
	}
	return self;
}
- (BOOL)scrollViewShouldScrollToTop:(UIScrollView *)scrollView {
	peliShellScrollTop();
	return NO;
}
// Never in the way of a touch at the very top of the page.
- (BOOL)pointInside:(CGPoint)point withEvent:(UIEvent *)event { return NO; }
@end

static PeliStatusBarTap *g_tap;

int peli_statusbar_watch(void *vcHandle) {
	__block int rc = 0;
	onMain(^{
		UIViewController *vc = (__bridge UIViewController *)vcHandle;
		if (!vc || ![vc isKindOfClass:UIViewController.class]) { rc = -1; return; }
		UIView *web = nil;
		@try { web = [vc valueForKey:@"webView"]; } @catch (NSException *e) {}
		if (![web isKindOfClass:WKWebView.class]) { rc = -2; return; }
		// Ours must be the only on-screen scroll view with scrollsToTop.
		((WKWebView *)web).scrollView.scrollsToTop = NO;
		if (!g_tap || g_tap.superview != vc.view) {
			[g_tap removeFromSuperview];
			g_tap = [[PeliStatusBarTap alloc] initWithFrame:CGRectMake(0, 0, vc.view.bounds.size.width, 1)];
			[vc.view addSubview:g_tap];
		}
		g_tap.contentOffset = CGPointMake(0, 1);
	});
	return rc;
}
