//go:build ios

// Package iosauth shows a sign-in page inside the app (ADR-0059), for
// AniList's redirect to a page Peli serves on the loopback address: the app
// has to stay active for that page to answer, and sending the user to Safari
// suspends it.
package iosauth

/*
#include <stdlib.h>
#include "auth_ios.h"
*/
import "C"

import (
	"errors"
	"fmt"
	"sync"
	"unsafe"
)

// callbackScheme is a scheme the page never redirects to: the sheet is
// closed by Close (or the user), not by a redirect.
const callbackScheme = "peli-signin"

var (
	mu    sync.Mutex
	ended func()
)

// Open shows address over the app. ended runs if the user dismisses the
// sheet (not after Close).
func Open(address string, onDismiss func()) error {
	mu.Lock()
	ended = onDismiss
	mu.Unlock()
	ca, cs := C.CString(address), C.CString(callbackScheme)
	defer C.free(unsafe.Pointer(ca))
	defer C.free(unsafe.Pointer(cs))
	switch rc := C.peli_auth_open(ca, cs); rc {
	case 0:
		return nil
	case -1:
		return errors.New("iosauth: not a web address")
	default:
		return fmt.Errorf("iosauth: sheet not shown (step %d)", int(rc))
	}
}

// Close dismisses the sheet.
func Close() { C.peli_auth_close() }

//export peliAuthEnded
func peliAuthEnded() {
	mu.Lock()
	f := ended
	mu.Unlock()
	if f != nil {
		f()
	}
}
