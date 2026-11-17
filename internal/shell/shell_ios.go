//go:build ios

package shell

/*
#cgo CFLAGS: -fobjc-arc
#cgo LDFLAGS: -framework UIKit -framework Foundation -framework QuartzCore -framework AVFoundation
#include <stdlib.h>
#include "tabbar_ios.h"
#include "scanner_ios.h"
*/
import "C"

import (
	"context"
	"encoding/json"
	"fmt"
	"sync"
	"unsafe"
)

// setTabBar hands the state to tabbar_ios.m as JSON, which builds the bar on
// the first call and animates to the new state after that.
func setTabBar(state TabBarState) error {
	vc := nativeWindow()
	if vc == nil {
		return nil
	}
	if state.Items == nil {
		state.Items = []TabItem{}
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return err
	}
	cs := C.CString(string(raw))
	defer C.free(unsafe.Pointer(cs))
	if rc := C.peli_tabbar_set(vc, cs); rc < 0 {
		return fmt.Errorf("shell: tab bar not shown (step %d)", int(rc))
	}
	return nil
}

func tabBarHeight() float64 {
	return float64(C.peli_tabbar_height(nativeWindow()))
}

//export peliShellTab
func peliShellTab(id *C.char) {
	tab := Tab{ID: C.GoString(id)}
	// Off the main thread: emitting may wait on it.
	go send(EventTab, tab)
}

//export peliShellSearch
func peliShellSearch() { go send(EventSearch, nil) }

//export peliShellExpand
func peliShellExpand() { go send(EventExpand, nil) }

// --- the QR scanner (scanner_ios.m) -------------------------------------------

func cameraAccess() string {
	switch C.peli_camera_access() {
	case 0:
		return CameraUndetermined
	case 1:
		return CameraGranted
	case 2:
		return CameraDenied
	default:
		return CameraUnavailable
	}
}

type scanResult struct {
	text   string
	status int
}

// One scan at a time: a new one replaces the one on screen.
var (
	scanMu   sync.Mutex
	scanDone chan scanResult
)

// scanQR presents the scanner and waits for a code, the user's close, or
// ctx.
func scanQR(ctx context.Context, prefix string) (string, error) {
	vc := nativeWindow()
	if vc == nil {
		return "", ErrNoScanner
	}
	done := make(chan scanResult, 1)
	scanMu.Lock()
	if scanDone != nil {
		scanDone <- scanResult{status: 1}
	}
	scanDone = done
	scanMu.Unlock()

	cs := C.CString(prefix)
	defer C.free(unsafe.Pointer(cs))
	C.peli_scan_start(vc, cs)
	select {
	case r := <-done:
		switch r.status {
		case 0:
			return r.text, nil
		case 1:
			return "", nil
		case 2:
			return "", ErrCameraDenied
		default:
			return "", ErrNoScanner
		}
	case <-ctx.Done():
		C.peli_scan_cancel()
		scanMu.Lock()
		if scanDone == done {
			scanDone = nil
		}
		scanMu.Unlock()
		return "", ctx.Err()
	}
}

// peliShellScanned ends the scan: status 0 is a code in text, 1 closed, 2
// camera denied, 3 no camera.
//
//export peliShellScanned
func peliShellScanned(text *C.char, status C.int) {
	r := scanResult{status: int(status)}
	if text != nil {
		r.text = C.GoString(text)
	}
	scanMu.Lock()
	d := scanDone
	scanDone = nil
	scanMu.Unlock()
	if d != nil {
		d <- r
	}
}
