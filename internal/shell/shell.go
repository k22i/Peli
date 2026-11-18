// Package shell is the native half of the iOS app's shell (#129): the
// floating Liquid Glass tab bar, a UIKit view over the webview that the
// frontend drives (useNativeTabBar in components/shell/native-tab-bar.ts).
//
// The Service is bound on every platform, because the frontend's bindings
// come from the desktop build and a bound method's id hashes its package,
// type and name (ADR-0055). Off iOS, and on iOS before 26 (no UIGlassEffect),
// it does nothing and TabBarHeight is 0, which tells the frontend to draw its
// CSS capsule instead.
package shell

import (
	"context"
	"sync"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The events native taps send to the frontend.
const (
	// EventTab is a tap on a tab, the current one included (re-tap).
	EventTab = "shell:tab"
	// EventSearch is a tap on the round Search button.
	EventSearch = "shell:search"
	// EventExpand is a tap on the minimised capsule: it grows back, and the
	// frontend stops asking for it minimised until the next scroll down.
	EventExpand = "shell:expand"
	// EventScrollTop is a tap on the status bar (#135): the page scrolls to
	// the top, as a re-tap of the current tab does on a section's root.
	EventScrollTop = "shell:scroll-top"
	// EventKeyboard is a hardware keyboard (an iPad's Magic Keyboard)
	// connecting or going away (#138), once HardwareKeyboard has been asked.
	EventKeyboard = "shell:keyboard"
)

// TabItem is one section in the capsule. Icon names an image in the app's
// asset catalog (build/ios/Assets.xcassets), such as "TabHome".
type TabItem struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Icon  string `json:"icon"`
}

// TabBarState is everything the native bar shows. The frontend sends all of
// it on each change; the bar animates from what it showed before.
type TabBarState struct {
	Items []TabItem `json:"items"`
	// Active is the selected item's id, or "" for none.
	Active string `json:"active"`
	// Hidden slides the bar off the bottom edge (player, focus screens,
	// sheets). The bar also hides itself while the keyboard is up.
	Hidden bool `json:"hidden"`
	// Minimized shrinks the capsule to a circle with the active icon.
	Minimized bool `json:"minimized"`
	// Theme is "light" or "dark": Peli's, which may differ from the OS's.
	Theme string `json:"theme"`
	// Search shows the round Search button beside the capsule.
	Search bool `json:"search"`
	// Placement is "bottom" (the floating capsule). Only "bottom" is drawn:
	// at regular width the iPad shows the frontend's CSS top bar and sidebar
	// instead (#138, decided by the user 2026-11-18).
	Placement string `json:"placement"`
}

// Keyboard is the payload of EventKeyboard.
type Keyboard struct {
	Attached bool `json:"attached"`
}

// Tab is the payload of EventTab.
type Tab struct {
	ID string `json:"id"`
}

func init() {
	application.RegisterEvent[Tab](EventTab)
	application.RegisterEvent[application.Void](EventSearch)
	application.RegisterEvent[application.Void](EventExpand)
	application.RegisterEvent[application.Void](EventScrollTop)
	application.RegisterEvent[Keyboard](EventKeyboard)
}

// Service is the bound shell API. The zero value is ready; UseWindow gives it
// the window to draw in on iOS.
type Service struct{}

var (
	mu     sync.Mutex
	emit   func(name string, data any)
	window func() unsafe.Pointer
)

// UseWindow names the window whose view controller the bar goes in (iOS).
// It isn't a method, so Wails doesn't bind it.
func UseWindow(nativeWindow func() unsafe.Pointer) {
	mu.Lock()
	window = nativeWindow
	mu.Unlock()
}

// ServiceStartup wires the native taps to the app's events.
func (*Service) ServiceStartup(context.Context, application.ServiceOptions) error {
	if app := application.Get(); app != nil {
		mu.Lock()
		emit = func(name string, data any) { app.Event.Emit(name, data) }
		mu.Unlock()
	}
	return nil
}

func send(name string, data any) {
	mu.Lock()
	e := emit
	mu.Unlock()
	if e != nil {
		e(name, data)
	}
}

func nativeWindow() unsafe.Pointer {
	mu.Lock()
	w := window
	mu.Unlock()
	if w == nil {
		return nil
	}
	return w()
}

// SetTabBar shows state in the native bar. A no-op off iOS 26.
func (*Service) SetTabBar(state TabBarState) error { return setTabBar(state) }

// TabBarHeight is the native capsule's height in points for the window's
// current size class (62 upright, 52 on an iPhone on its side), or 0 when
// there is no native bar (desktop, iOS before 26): the frontend then draws
// its own.
func (*Service) TabBarHeight() float64 { return tabBarHeight() }

// WatchStatusBar makes a tap on the status bar send EventScrollTop (#135).
// Pages scroll inside the webview, not in its UIScrollView, so UIKit's own
// scroll-to-top had nothing to scroll. Safe to call more than once (after a
// WebKit reload). A no-op off iOS.
func (*Service) WatchStatusBar() error { return watchStatusBar() }

// HardwareKeyboard says whether a hardware keyboard is attached (GCKeyboard,
// iPad), and from then on sends EventKeyboard when one connects or goes
// away, so the frontend can turn the desktop shortcuts on and off (#138).
// Always false off iOS, where the shortcuts are on anyway.
func (*Service) HardwareKeyboard() bool { return hardwareKeyboard() }
