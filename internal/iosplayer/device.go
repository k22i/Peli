//go:build ios

package iosplayer

// #include "host_ios.h"
import "C"

// Phone reports whether the app runs on an iPhone (not an iPad).
func Phone() bool { return C.peli_is_phone() != 0 }
