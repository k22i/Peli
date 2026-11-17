//go:build ios

package haptics

/*
#cgo CFLAGS: -fobjc-arc
#cgo LDFLAGS: -framework UIKit -framework Foundation
#include "haptics_ios.h"
*/
import "C"

func impact(kind string) {
	k := C.PELI_HAPTIC_LIGHT
	switch kind {
	case Medium:
		k = C.PELI_HAPTIC_MEDIUM
	case Heavy:
		k = C.PELI_HAPTIC_HEAVY
	case Selection:
		k = C.PELI_HAPTIC_SELECTION
	case Success:
		k = C.PELI_HAPTIC_SUCCESS
	case Warning:
		k = C.PELI_HAPTIC_WARNING
	case Error:
		k = C.PELI_HAPTIC_ERROR
	}
	C.peli_haptic(C.int(k))
}
