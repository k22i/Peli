//go:build ios

package shell

/*
#cgo CFLAGS: -fobjc-arc
#cgo LDFLAGS: -framework UIKit -framework Foundation -framework QuartzCore -framework WebKit -framework GameController
#include <stdlib.h>
#include "tabbar_ios.h"
*/
import "C"

import (
	"encoding/json"
	"fmt"
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

func watchStatusBar() error {
	vc := nativeWindow()
	if vc == nil {
		return nil
	}
	if rc := C.peli_statusbar_watch(vc); rc < 0 {
		return fmt.Errorf("shell: status-bar tap not watched (step %d)", int(rc))
	}
	return nil
}

func hardwareKeyboard() bool { return C.peli_keyboard_watch() != 0 }

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

//export peliShellScrollTop
func peliShellScrollTop() { go send(EventScrollTop, nil) }

//export peliShellKeyboard
func peliShellKeyboard(attached C.int) {
	go send(EventKeyboard, Keyboard{Attached: attached != 0})
}
