//go:build ios

package iosplayer

// #include "host_ios.h"
import "C"

import (
	"log/slog"
	"math"
	"sync/atomic"

	"github.com/k22i/Peli/internal/playback"
)

// Phone reports whether the app runs on an iPhone (not an iPad).
func Phone() bool { return C.peli_is_phone() != 0 }

// Build is the app's CFBundleVersion, the build number ("" when it has none).
func Build() string {
	var buf [64]C.char
	if C.peli_bundle_build(&buf[0], C.int(len(buf))) == 0 {
		return ""
	}
	return C.GoString(&buf[0])
}

// ShowWebview fades in the webview that was kept clear since launch (see
// peli_quiet_webview in host_ios.m). Safe to call more than once.
func ShowWebview() { C.peli_show_webview() }

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

// The touch player's swipes (#131): the screen's brightness and the system
// volume, set natively (host_ios.m), and the system chrome hidden while the
// player is up. player.Service forwards its bound methods of the same names
// here.

func level(v float64) bool { return !math.IsNaN(v) && v >= 0 && v <= 1 }

// SetBrightness sets the player's screen brightness, 0–1. The screen's own
// level is saved first and comes back at Stop and whenever the app leaves
// the screen (iOS doesn't restore it).
func (e *Engine) SetBrightness(v float64) error {
	if !level(v) {
		return playback.ErrInvalid
	}
	C.peli_brightness_set(C.double(v))
	return nil
}

// Brightness is the screen's brightness, 0–1, or -1 when there is no screen.
func (e *Engine) Brightness() float64 { return float64(C.peli_brightness_get()) }

// volumeFallback is set once the system volume couldn't be set and mpv's
// volume stands in for it.
var volumeFallback atomic.Bool

// SetSystemVolume sets the system volume, 0–1, through the hidden volume
// view's slider. Without one (iOS changed MPVolumeView, or the player isn't
// attached) it falls back to mpv's own volume.
func (e *Engine) SetSystemVolume(v float64) error {
	if !level(v) {
		return playback.ErrInvalid
	}
	if C.peli_volume_set(C.double(v)) == 0 {
		return nil
	}
	if !volumeFallback.Swap(true) {
		slog.Warn("iosplayer: no system volume slider, the swipe sets mpv's volume instead")
	}
	return e.SetVolume(v * 100)
}

// SystemVolume is the output volume, 0–1 (mpv's, after a fallback).
func (e *Engine) SystemVolume() float64 {
	if volumeFallback.Load() {
		return e.Snapshot().Volume / 100
	}
	return float64(C.peli_volume_get())
}

var systemVolume atomic.Pointer[func(float64)]

// OnSystemVolume has changed called with every change of the system volume
// while the player is attached, the hardware buttons' included (iOS
// doesn't show its HUD then, so the player shows its own).
func (e *Engine) OnSystemVolume(changed func(float64)) { systemVolume.Store(&changed) }

//export peliSystemVolume
func peliSystemVolume(v C.double) {
	if changed := systemVolume.Load(); changed != nil {
		// Off UIKit's thread: emitting may wait on it.
		go (*changed)(float64(v))
	}
}

// SetImmersive hides the status bar and the home indicator, and keeps the
// first swipe from a screen edge for the player (on), or gives them back.
func (e *Engine) SetImmersive(on bool) error {
	flag := 0
	if on {
		flag = 1
	}
	C.peli_immersive(C.int(flag))
	return nil
}
