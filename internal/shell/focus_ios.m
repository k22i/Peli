//go:build ios

// The native Search button opens the keyboard (#129, #137). The tap is in
// UIKit, not in the webview, so the Search field's focus() that follows is
// "not user initiated" to WebKit, which then focuses the field without
// showing the keyboard. For a short window after that tap only, WebKit is
// told the user is interacting: WKContentView's private
// _elementDidFocus:userIsInteracting:… gets YES for its second argument.
//
// The selector has changed over WebKit releases (blurPreviousNode:
// changingActivityState:… before iOS 13, activityStateChanges:… since), so
// every WKContentView method starting with _elementDidFocus:userIsInteracting:
// is wrapped, as long as all its arguments are integers or pointers (passed
// in x2–x7 on arm64, so one pass-through IMP fits each). Anything else is
// left alone and the keyboard simply stays down, as before.
#import <UIKit/UIKit.h>
#import <objc/runtime.h>
#include <string.h>

#include "tabbar_ios.h"

static CFAbsoluteTime g_allowUntil;

// Takes the window once: the first focus inside it, then it closes.
static BOOL takeWindow(void) {
	if (CFAbsoluteTimeGetCurrent() > g_allowUntil) return NO;
	g_allowUntil = 0;
	return YES;
}

typedef void (*FocusIMP)(id, SEL, uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t, uintptr_t);

// Whether every argument after self and _cmd is an integer, BOOL or pointer,
// and the second one (userIsInteracting) is a BOOL.
static BOOL plainArguments(Method m) {
	unsigned n = method_getNumberOfArguments(m);
	if (n < 4 || n > 8) return NO;
	for (unsigned i = 2; i < n; i++) {
		char *t = method_copyArgumentType(m, i);
		if (!t) return NO;
		// Skip type qualifiers (const, in, out…).
		const char *c = t;
		while (*c && strchr("rnNoORV", *c)) c++;
		BOOL ok = *c && strchr("cislqCISLQB^*@#:", *c) != NULL;
		BOOL boolArg = *c == 'B' || *c == 'c';
		free(t);
		if (!ok || (i == 3 && !boolArg)) return NO;
	}
	return YES;
}

static void wrap(Class cls, Method m) {
	SEL sel = method_getName(m);
	FocusIMP original = (FocusIMP)method_getImplementation(m);
	IMP wrapped = imp_implementationWithBlock(^(id self, uintptr_t a, uintptr_t interacting, uintptr_t c,
	                                            uintptr_t d, uintptr_t e, uintptr_t f) {
		if (!(interacting & 0xff) && takeWindow()) interacting = 1;
		original(self, sel, a, interacting, c, d, e, f);
	});
	method_setImplementation(m, wrapped);
}

static void installOnce(void) {
	static dispatch_once_t once;
	dispatch_once(&once, ^{
		Class cls = NSClassFromString(@"WKContentView");
		if (!cls) return;
		unsigned count = 0;
		Method *methods = class_copyMethodList(cls, &count);
		for (unsigned i = 0; i < count; i++) {
			const char *name = sel_getName(method_getName(methods[i]));
			if (strncmp(name, "_elementDidFocus:userIsInteracting:", 35) == 0 && plainArguments(methods[i])) {
				wrap(cls, methods[i]);
			}
		}
		free(methods);
	});
}

void peli_focus_allow_keyboard(double seconds) {
	void (^work)(void) = ^{
		installOnce();
		g_allowUntil = CFAbsoluteTimeGetCurrent() + seconds;
	};
	if (NSThread.isMainThread) work();
	else dispatch_async(dispatch_get_main_queue(), work);
}
