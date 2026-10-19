//go:build linux

package main

/*
#cgo pkg-config: gtk4 x11
#cgo CFLAGS: -Wno-deprecated-declarations
#include <gtk/gtk.h>
#ifdef GDK_WINDOWING_X11
#include <gdk/x11/gdkx.h>
#endif
#ifdef GDK_WINDOWING_WAYLAND
#include <gdk/wayland/gdkwayland.h>
#endif
#include <X11/Xlib.h>
#include <stdlib.h>

// backend: 1 = X11, 2 = Wayland, 0 = unknown.
static int surfaceBackend(void *win) {
	GdkSurface *s = gtk_native_get_surface(GTK_NATIVE(win));
	if (!s) return 0;
#ifdef GDK_WINDOWING_X11
	if (GDK_IS_X11_SURFACE(s)) return 1;
#endif
#ifdef GDK_WINDOWING_WAYLAND
	if (GDK_IS_WAYLAND_SURFACE(s)) return 2;
#endif
	return 0;
}

static unsigned long x11Xid(void *win) {
#ifdef GDK_WINDOWING_X11
	GdkSurface *s = gtk_native_get_surface(GTK_NATIVE(win));
	if (s && GDK_IS_X11_SURFACE(s)) return gdk_x11_surface_get_xid(s);
#endif
	return 0;
}

// Wails v3 beta.28's GTK4 setTransparent() is an empty stub, so the window
// keeps the theme background. Clear it with CSS ourselves.
static void makeTransparent(void *win) {
	static GtkCssProvider *provider = NULL;
	if (!provider) {
		provider = gtk_css_provider_new();
		gtk_css_provider_load_from_string(provider, "window.cove-transparent { background: transparent; }");
		gtk_style_context_add_provider_for_display(gdk_display_get_default(),
			GTK_STYLE_PROVIDER(provider), GTK_STYLE_PROVIDER_PRIORITY_APPLICATION);
	}
	gtk_widget_add_css_class(GTK_WIDGET(win), "cove-transparent");
}

static void setTransient(void *child, void *parent) {
	gtk_window_set_transient_for(GTK_WINDOW(child), GTK_WINDOW(parent));
}

// queryParent returns the parent of an X window plus its geometry, using a
// private Xlib connection so we don't touch GDK's.
static int queryParent(unsigned long win, unsigned long *parent, int *x, int *y, unsigned *w, unsigned *h, int *mapped) {
	Display *d = XOpenDisplay(NULL);
	if (!d) return -1;
	Window root, par, *kids = NULL;
	unsigned int nkids = 0;
	if (!XQueryTree(d, (Window)win, &root, &par, &kids, &nkids)) { XCloseDisplay(d); return -2; }
	if (kids) XFree(kids);
	*parent = par;
	XWindowAttributes a;
	if (XGetWindowAttributes(d, (Window)win, &a)) {
		*x = a.x; *y = a.y; *w = a.width; *h = a.height; *mapped = a.map_state == IsViewable;
	}
	XCloseDisplay(d);
	return 0;
}
*/
import "C"

import (
	"fmt"
	"os"

	"github.com/wailsapp/wails/v3/pkg/application"
)

type nativeTarget struct {
	WID  int64
	Kind string
	Note string
}

func windowTarget(w *application.WebviewWindow) nativeTarget {
	type res struct {
		backend int
		xid     uint64
	}
	r := application.InvokeSyncWithResult(func() res {
		win := w.NativeWindow()
		return res{int(C.surfaceBackend(win)), uint64(C.x11Xid(win))}
	})
	switch r.backend {
	case 1:
		return nativeTarget{WID: int64(r.xid), Kind: "X11 Window", Note: "GdkX11Surface XID of the GTK4 toplevel"}
	case 2:
		return nativeTarget{WID: -1, Kind: "wl_surface", Note: "Wayland has no foreign-surface embedding; mpv 0.41 does not read --wid on Wayland, so it is not passed"}
	}
	return nativeTarget{WID: -1, Kind: "unknown", Note: "GDK backend not detected"}
}

func extraMpvArgs() []string {
	// mpv picks its own GPU context; on Wayland sessions it would pick the
	// Wayland one, which can never be embedded. SPIKE_MPV_ARGS lets the
	// runner force e.g. --gpu-context=x11egl or --vo=x11 under Xvfb.
	if a := os.Getenv("SPIKE_MPV_ARGS"); a != "" {
		return splitArgs(a)
	}
	return nil
}

func inspectEmbed(p *Player, target nativeTarget) map[string]any {
	out := map[string]any{"hostKind": target.Kind, "hostWid": target.WID}
	var mpvWin int64
	if err := p.ipc.getProperty("window-id", &mpvWin); err != nil {
		out["mpvWindowId"] = "unavailable: " + err.Error()
		out["embedded"] = false
		out["verdict"] = "mpv exposes no X11 window-id (Wayland or no VO window)"
		return out
	}
	out["mpvWindowId"] = mpvWin
	var parent C.ulong
	var x, y, mapped C.int
	var w, h C.uint
	if rc := C.queryParent(C.ulong(mpvWin), &parent, &x, &y, &w, &h, &mapped); rc != 0 {
		out["error"] = fmt.Sprintf("XQueryTree rc=%d", int(rc))
		return out
	}
	out["mpvParent"] = uint64(parent)
	out["mpvGeometry"] = fmt.Sprintf("%d,%d %dx%d", x, y, w, h)
	out["mpvMapped"] = mapped != 0
	out["embedded"] = int64(parent) == target.WID
	if int64(parent) == target.WID {
		out["verdict"] = "mpv window is a child of the Wails toplevel"
	} else {
		out["verdict"] = "mpv window is not parented to the Wails toplevel"
	}
	return out
}

func makeTransparent(w *application.WebviewWindow) {
	if os.Getenv("SPIKE_NO_CSS_FIX") != "" {
		return
	}
	application.InvokeSync(func() { C.makeTransparent(w.NativeWindow()) })
}

func attachOverlay(main, overlay *application.WebviewWindow) {
	application.InvokeSync(func() { C.setTransient(overlay.NativeWindow(), main.NativeWindow()) })
	// Window managers only restack a transient when it is (re)presented.
	// (Not on Windows: Focus() before WebView2 is ready panics in Wails
	// beta.28, and owned windows stay above their owner anyway.)
	overlay.Focus()
}
