//go:build ios

package iosplayer

// #include "host_ios.h"
import "C"

import "sync/atomic"

// Phone reports whether the app runs on an iPhone (not an iPad).
func Phone() bool { return C.peli_is_phone() != 0 }

// Side is a way up for the screen (interface orientations, so landscape-left
// has the phone's top to the right).
type Side int

const (
	Portrait       Side = C.PELI_SIDE_PORTRAIT
	LandscapeLeft  Side = C.PELI_SIDE_LANDSCAPE_LEFT
	LandscapeRight Side = C.PELI_SIDE_LANDSCAPE_RIGHT
)

func (s Side) String() string {
	switch s {
	case LandscapeLeft:
		return "landscape-left"
	case LandscapeRight:
		return "landscape-right"
	}
	return "portrait"
}

var motionTurn atomic.Pointer[func(Side)]

// FollowMotion calls turn, from another goroutine, each time the phone is
// held on another side (and once at the start), until StopMotion. It reads
// the motion sensor, so Rotation Lock doesn't hide the turns.
func FollowMotion(turn func(Side)) {
	motionTurn.Store(&turn)
	C.peli_motion_start()
}

// StopMotion ends FollowMotion.
func StopMotion() {
	motionTurn.Store(nil)
	C.peli_motion_stop()
}

// Turn asks for the screen to show side. The view controller's orientation
// mask must allow it (application.IOS.SetOrientation).
func Turn(side Side) { C.peli_turn(C.int(side)) }

//export peliMotionSide
func peliMotionSide(side C.int) {
	if turn := motionTurn.Load(); turn != nil {
		(*turn)(Side(side))
	}
}
