//go:build darwin

// Package firstmouse makes a click on an inactive Cove window act on what it
// hits, instead of only activating the window. WKWebView refuses that first
// click by default, so the user had to click every control twice (#8, #12),
// and Wails beta.28 has no option for it.
package firstmouse

/*
#cgo CFLAGS: -x objective-c -fobjc-arc
#cgo LDFLAGS: -framework Cocoa -framework WebKit
#import <Cocoa/Cocoa.h>
#import <WebKit/WebKit.h>
#import <objc/runtime.h>

static BOOL acceptsFirstMouse(id self, SEL _cmd, NSEvent *event) {
	return YES;
}

// class_replaceMethod adds the override to WKWebView itself, so NSView and
// every other view keep the default.
static void enable(void) {
	SEL sel = @selector(acceptsFirstMouse:);
	Method inherited = class_getInstanceMethod([WKWebView class], sel);
	class_replaceMethod([WKWebView class], sel, (IMP)acceptsFirstMouse,
		method_getTypeEncoding(inherited));
}
*/
import "C"

// Enable applies to every WKWebView in the process. Call it before the first
// window opens.
func Enable() {
	C.enable()
}
