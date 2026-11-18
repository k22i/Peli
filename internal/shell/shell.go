// Package shell is the native half of the iOS app's shell (#129): the
// floating Liquid Glass tab bar, a UIKit view over the webview that the
// frontend drives (useNativeTabBar in components/shell/native-tab-bar.ts),
// and the camera's QR scanner for device pairing (#133).
//
// The Service is bound on every platform, because the frontend's bindings
// come from the desktop build and a bound method's id hashes its package,
// type and name (ADR-0055). Off iOS, and on iOS before 26 (no UIGlassEffect),
// it does nothing and TabBarHeight is 0, which tells the frontend to draw its
// CSS capsule instead.
package shell

import (
	"context"
	"encoding/json"
	"errors"
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
	// Placement is "bottom" (the iPhone's floating capsule). Kept a field so
	// an iPad can ask for "top" later (#138); only "bottom" is drawn now.
	Placement string `json:"placement"`
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

// --- the QR scanner (#133) ----------------------------------------------------

// Camera access, as CameraAccess reports it.
const (
	CameraGranted      = "granted"
	CameraDenied       = "denied"
	CameraUndetermined = "undetermined"
	// No camera here (the desktop, or a device without one): the frontend
	// shows the phrase field instead.
	CameraUnavailable = "unavailable"
)

var (
	// ErrNoScanner means this device has no camera to scan with.
	ErrNoScanner = errors.New("shell: no camera to scan with")
	// ErrCameraDenied means the user turned camera access off for Peli.
	ErrCameraDenied = errors.New("shell: camera access is off for Peli")
)

// CameraAccess says whether ScanQR can open the camera: "granted",
// "denied", "undetermined" (iOS asks on the first scan) or "unavailable".
func (*Service) CameraAccess() string { return cameraAccess() }

// ScanQR opens the camera full screen over the app and returns the text of
// the first QR code that starts with prefix ("" for any), or "" if the user
// closed it. On iOS it's AVFoundation's QR reader (VisionKit's scanner is
// Swift-only, ADR-0061); the camera prompt appears on the first scan. Off iOS
// it fails with ErrNoScanner.
func (*Service) ScanQR(ctx context.Context, prefix string) (string, error) {
	return scanQR(ctx, prefix)
}

// OpenAppSettings opens Peli's page in the Settings app (iOS), where Camera
// and Local Network access are turned back on. A no-op elsewhere.
func (*Service) OpenAppSettings() { openAppSettings() }

// MarshalError gives the frontend a code for the scanner's errors.
func MarshalError(err error) []byte {
	var code string
	switch {
	case errors.Is(err, ErrNoScanner):
		code = "no_scanner"
	case errors.Is(err, ErrCameraDenied):
		code = "camera_denied"
	default:
		return nil
	}
	data, _ := json.Marshal(map[string]string{"code": code})
	return data
}
