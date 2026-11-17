//go:build ios

package main

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/iosplayer"
	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/streams"
)

// rotatingEngine applies YouTube's rotation rule on an iPhone: the app stays
// upright while you browse, and turns with the phone while the player has a
// file open. Opening a file lets the screen turn, at once if the phone is
// already held sideways. Stop, which leaving the player screen always calls,
// turns it upright again. An iPad turns on every screen, as before.
func rotatingEngine(e *iosplayer.Engine) playback.Engine {
	if !iosplayer.Phone() {
		return e
	}
	application.IOS.SetOrientation("portrait")
	return rotating{e}
}

// rotating is the iOS engine with the orientation lock lifted between Load
// and Stop. Every other control goes straight to the engine.
type rotating struct{ *iosplayer.Engine }

func (r rotating) Load(source streams.Source, opts playback.LoadOptions) error {
	application.IOS.SetOrientation("auto")
	return r.Engine.Load(source, opts)
}

func (r rotating) Stop() error {
	// Turn upright first: the screen behind the player is already showing,
	// and ending the session can take a moment (the last report).
	application.IOS.SetOrientation("portrait")
	return r.Engine.Stop()
}
