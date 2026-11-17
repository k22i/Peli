//go:build ios

// Package iosshell is Peli's native additions to Wails' iOS shell (#127):
// the webview coming back after iOS kills its content process, failed loads
// logged, memory warnings, and the share sheet for the logs. It holds no
// policy: main_ios.go connects it to internal/diagnostics.
package iosshell

/*
#cgo CFLAGS: -fobjc-arc
#cgo LDFLAGS: -framework UIKit -framework WebKit -framework Foundation
#include <stdlib.h>
#include "shell_ios.h"
*/
import "C"

import (
	"errors"
	"unsafe"
)

// Handlers are what the native side calls into.
type Handlers struct {
	// Terminated says what to load after the content process died: action
	// 0 reload, 1 Home, 2 the error page (url empty).
	Terminated func(current string) (action int, url string)
	// NavigationFailed is a failed load of one of Peli's pages.
	NavigationFailed func(kind, url, reason string)
	// MemoryWarning is UIApplicationDidReceiveMemoryWarningNotification.
	MemoryWarning func()
}

var handlers Handlers

// Handle sets the handlers. Call it before the app runs.
func Handle(h Handlers) { handlers = h }

//export peliWebContentTerminated
func peliWebContentTerminated(current *C.char, action *C.int) *C.char {
	if handlers.Terminated == nil {
		*action = 0
		return C.CString(C.GoString(current))
	}
	a, url := handlers.Terminated(C.GoString(current))
	*action = C.int(a)
	if url == "" {
		return nil
	}
	return C.CString(url)
}

//export peliNavigationFailed
func peliNavigationFailed(kind, url, reason *C.char) {
	if handlers.NavigationFailed != nil {
		handlers.NavigationFailed(C.GoString(kind), C.GoString(url), C.GoString(reason))
	}
}

//export peliMemoryWarning
func peliMemoryWarning() {
	if handlers.MemoryWarning != nil {
		// Off the main thread: it runs a GC.
		go handlers.MemoryWarning()
	}
}

// Platform is the iOS side of diagnostics.Platform.
type Platform struct{}

// Share opens the share sheet with the files.
func (Platform) Share(paths []string) error {
	if len(paths) == 0 {
		return nil
	}
	cs := make([]*C.char, len(paths))
	for i, p := range paths {
		cs[i] = C.CString(p)
	}
	defer func() {
		for _, c := range cs {
			C.free(unsafe.Pointer(c))
		}
	}()
	if C.peli_shell_share((**C.char)(unsafe.Pointer(&cs[0])), C.int(len(cs))) != 0 {
		return errors.New("iosshell: no window to share from")
	}
	return nil
}

// Memory is what iOS still lets the app have, and its footprint.
func (Platform) Memory() (available, footprint uint64, ok bool) {
	var a, f C.uint64_t
	C.peli_shell_memory(&a, &f)
	return uint64(a), uint64(f), true
}

// Device is the iOS version and the hardware model.
func (Platform) Device() string {
	buf := make([]byte, 128)
	C.peli_shell_device((*C.char)(unsafe.Pointer(&buf[0])), C.int(len(buf)))
	for i, b := range buf {
		if b == 0 {
			return string(buf[:i])
		}
	}
	return string(buf)
}
