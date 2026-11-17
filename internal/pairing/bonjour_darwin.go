//go:build darwin && !ios

package pairing

/*
#include <stdlib.h>
#include "bonjour_darwin.h"
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"time"
	"unsafe"
)

// PhraseAvailable reports whether this build can pair by phrase: a Mac,
// through the system's DNS-SD (mDNSResponder), which needs no entitlement.
const PhraseAvailable = true

// advertise registers _peli-pair._tcp on port with the phrase's tag in its
// TXT record, until the returned func is called.
func advertise(tag int, port uint16) (func(), error) {
	t := C.CString(strconv.Itoa(tag))
	defer C.free(unsafe.Pointer(t))
	ref := C.peli_bonjour_register(C.uint16_t(port), t)
	if ref == nil {
		return nil, errors.New("pairing: Bonjour registration failed")
	}
	return func() { C.peli_bonjour_stop(ref) }, nil
}

// find browses for the advert with tag, for up to 8 seconds or ctx.
func find(ctx context.Context, tag int) (string, uint16, error) {
	timeout := 8 * time.Second
	if deadline, ok := ctx.Deadline(); ok && time.Until(deadline) < timeout {
		timeout = time.Until(deadline)
	}
	t := C.CString(strconv.Itoa(tag))
	defer C.free(unsafe.Pointer(t))
	host := (*C.char)(C.malloc(1025))
	defer C.free(unsafe.Pointer(host))
	var port C.uint16_t
	type found struct {
		rc C.int
	}
	ch := make(chan found, 1)
	go func() {
		ch <- found{C.peli_bonjour_find(t, C.int(timeout.Milliseconds()), host, 1025, &port)}
	}()
	select {
	case <-ctx.Done():
		// The browse ends by itself at its timeout; wait for it so host
		// isn't freed under it.
		<-ch
		return "", 0, ctx.Err()
	case f := <-ch:
		switch {
		case f.rc == 0:
			return C.GoString(host), uint16(port), nil
		case f.rc == 1:
			return "", 0, ErrNoSender
		default:
			return "", 0, fmt.Errorf("%w: DNS-SD error %d", ErrNoSender, int(f.rc))
		}
	}
}
