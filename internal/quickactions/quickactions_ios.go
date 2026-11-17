//go:build ios

package quickactions

/*
#cgo CFLAGS: -fobjc-arc
#cgo LDFLAGS: -framework UIKit -framework Foundation
#include <stdlib.h>
#include "quickactions_ios.h"
*/
import "C"

import (
	"encoding/json"
	"unsafe"
)

// setItems hands the items to quickactions_ios.m as JSON, which sets
// UIApplication.shortcutItems on the main thread.
func setItems(items []Item) error {
	raw, err := json.Marshal(items)
	if err != nil {
		return err
	}
	cs := C.CString(string(raw))
	defer C.free(unsafe.Pointer(cs))
	C.peli_quickactions_set(cs)
	return nil
}

// peliQuickAction is a tap on an icon-menu item (a running app, or the
// launch itself): kind is the item's type, info the JSON of its userInfo.
//
//export peliQuickAction
func peliQuickAction(kind *C.char, info *C.char) {
	var a Action
	if info != nil {
		_ = json.Unmarshal([]byte(C.GoString(info)), &a)
	}
	switch C.GoString(kind) {
	case typeSearch:
		a = Action{Kind: KindSearch}
	case typeLibrary:
		a = Action{Kind: KindLibrary}
	case typeTitle:
		a.Kind = KindTitle
		a.Play = true
	default:
		return
	}
	fire(a)
}

// The items' types: Info.plist's static ones, and the dynamic title.
const (
	typeSearch  = "net.k22i.peli.search"
	typeLibrary = "net.k22i.peli.library"
	typeTitle   = "net.k22i.peli.title"
)
