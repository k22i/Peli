//go:build darwin

package main

/*
#cgo CFLAGS: -x objective-c
#cgo LDFLAGS: -framework Cocoa -framework CoreGraphics
#import <Cocoa/Cocoa.h>
#import <CoreGraphics/CoreGraphics.h>

static void *contentView(void *nsWindow) {
	return (__bridge void *)[(__bridge NSWindow *)nsWindow contentView];
}

static void addChild(void *parent, void *child) {
	[(__bridge NSWindow *)parent addChildWindow:(__bridge NSWindow *)child ordered:NSWindowAbove];
}

// countWindows reports how many on-screen windows the given pid owns, and the
// bounds of the largest one.
static int countWindows(int pid, double *x, double *y, double *w, double *h) {
	CFArrayRef list = CGWindowListCopyWindowInfo(kCGWindowListOptionOnScreenOnly, kCGNullWindowID);
	if (!list) return -1;
	int n = 0;
	double best = 0;
	for (CFIndex i = 0; i < CFArrayGetCount(list); i++) {
		NSDictionary *d = (__bridge NSDictionary *)CFArrayGetValueAtIndex(list, i);
		if ([d[(id)kCGWindowOwnerPID] intValue] != pid) continue;
		if ([d[(id)kCGWindowLayer] intValue] != 0) continue;
		CGRect r;
		CGRectMakeWithDictionaryRepresentation((__bridge CFDictionaryRef)d[(id)kCGWindowBounds], &r);
		n++;
		if (r.size.width * r.size.height > best) {
			best = r.size.width * r.size.height;
			*x = r.origin.x; *y = r.origin.y; *w = r.size.width; *h = r.size.height;
		}
	}
	CFRelease(list);
	return n;
}
*/
import "C"

import (
	"fmt"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type nativeTarget struct {
	WID  int64
	Kind string
	Note string
}

// windowTarget hands mpv the NSView* of the window's content view, which is
// what the (removed) Cocoa --wid used to expect. The pointer is only valid in
// this process, so a child process can never use it; we pass it anyway to
// record what mpv does.
func windowTarget(w *application.WebviewWindow) nativeTarget {
	view := application.InvokeSyncWithResult(func() uintptr {
		return uintptr(C.contentView(w.NativeWindow()))
	})
	return nativeTarget{
		WID:  int64(view),
		Kind: "NSView*",
		Note: "in-process pointer; mpv 0.41 has no Cocoa --wid support (only x11/win32/android read it)",
	}
}

func extraMpvArgs() []string { return nil }

func inspectEmbed(p *Player, _ nativeTarget) map[string]any {
	var x, y, w, h C.double
	n := C.countWindows(C.int(p.cmd.Process.Pid), &x, &y, &w, &h)
	b := p.window.Bounds()
	out := map[string]any{
		"mpvPid":             p.cmd.Process.Pid,
		"mpvOnScreenWindows": int(n),
		"hostBounds":         fmt.Sprintf("%d,%d %dx%d", b.X, b.Y, b.Width, b.Height),
	}
	if n > 0 {
		out["mpvWindowBounds"] = fmt.Sprintf("%.0f,%.0f %.0fx%.0f", x, y, w, h)
		out["embedded"] = false
		out["verdict"] = "mpv ignored --wid and opened its own top-level window"
	} else {
		out["embedded"] = false
		out["verdict"] = "mpv has no on-screen window; video is not visible in the host"
	}
	return out
}

func makeTransparent(*application.WebviewWindow) {}

func attachOverlay(main, overlay *application.WebviewWindow) {
	application.InvokeSync(func() {
		C.addChild(main.NativeWindow(), overlay.NativeWindow())
	})
}
