//go:build ios

package main

import (
	"log/slog"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/iosplayer"
	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/streams"
)

// rotatingEngine applies YouTube's full-screen rule on an iPhone: the app
// stays upright while you browse, and the player is landscape however the
// phone is held, Rotation Lock or not. Load turns it to landscape at once
// (the home indicator on the right, YouTube's default); until Stop (which
// leaving the player screen always calls) the motion sensor only picks which
// landscape side, when the phone is turned the other way round. Stop turns
// the app upright again. An iPad turns on every screen, as before.
//
// Unlocking the orientation ("auto") and leaving the turn to iOS did nothing
// on an iPhone 14 Pro (iOS 27), with Rotation Lock on or off, so the player
// asks for each side itself.
func rotatingEngine(e *iosplayer.Engine) playback.Engine {
	if !iosplayer.Phone() {
		return e
	}
	application.IOS.SetOrientation("portrait")
	return &rotating{Engine: e}
}

// rotating is the iOS engine with the motion sensor followed between Load
// and Stop. Every other control goes straight to the engine.
type rotating struct {
	*iosplayer.Engine
	mu        sync.Mutex
	following bool
}

func (r *rotating) Load(source streams.Source, opts playback.LoadOptions) error {
	r.mu.Lock()
	if !r.following {
		r.following = true
		slog.Info("rotation: player landscape")
		turnTo(iosplayer.LandscapeRight)
		iosplayer.FollowMotion(r.turn)
	}
	r.mu.Unlock()
	return r.Engine.Load(source, opts)
}

func (r *rotating) Stop() error {
	// Turn upright first: the screen behind the player is already showing,
	// and ending the session can take a moment (the last report).
	r.mu.Lock()
	if r.following {
		r.following = false
		iosplayer.StopMotion()
		turnTo(iosplayer.Portrait)
	}
	r.mu.Unlock()
	return r.Engine.Stop()
}

// turn is the motion sensor's new side. The player stays landscape, so
// upright is ignored, and one already on its way when Stop came is dropped.
func (r *rotating) turn(side iosplayer.Side) {
	if side == iosplayer.Portrait {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	if r.following {
		turnTo(side)
	}
}

// turnTo shows side: the view controller's mask (Wails' orientation lock)
// first, so it allows the side, then the scene is asked for it.
func turnTo(side iosplayer.Side) {
	slog.Info("rotation: turn", "side", side)
	if side == iosplayer.Portrait {
		application.IOS.SetOrientation("portrait")
	} else {
		application.IOS.SetOrientation("landscape")
	}
	iosplayer.Turn(side)
}
