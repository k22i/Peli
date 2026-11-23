package playback

import (
	"context"

	"github.com/k22i/Peli/internal/streams"
)

// Engine is what plays a stream: the controls the touch and desktop player
// screens share. The desktop engine is player.Service (libmpv under the
// webview); the iOS one (libmpv in a UIKit view under the transparent
// webview, ADR-0055) implements the same set and is handed to the iOS
// player.Service with player.UseEngine. A title's picture, framing, quality
// and sound are not in the set: they are an engine's own optional methods,
// which a Service forwards to when its engine has them (the iOS one does,
// with the rules in adjust.go), as it does stats and the touch player's
// controls. What is left of the desktop Service's methods (the mini player,
// screenshots, loops, frame stepping, fullscreen and the audio devices) is
// desktop-only and stays out of it.
//
// An Engine reports back through a Sink it is given when it is made.
type Engine interface {
	// Load starts source at opts.Start, replacing what plays.
	Load(source streams.Source, opts LoadOptions) error
	// Stop ends the session. It is not an error when nothing plays.
	Stop() error
	// Snapshot is the state now; events carry the changes after it.
	Snapshot() State

	SetPaused(paused bool) error
	Seek(position float64) error
	SeekBy(delta float64) error
	// Scrub seeks while the seek bar is dragged: it may drop positions
	// it hasn't got to yet.
	Scrub(position float64) error
	SetVolume(volume float64) error
	SetMuted(muted bool) error
	SetSpeed(speed float64) error

	SetAudioTrack(id int) error
	SetSubtitleTrack(id int) error
	SetSecondarySubtitleTrack(id int) error
	SetSubtitleDelay(delay float64) error
	SetSubtitleSize(size string) error
	SetSubtitleStyle(style SubtitleStyle) error
	// AddSubtitle downloads sub, adds it as an external track and shows
	// it. It returns the new track's id.
	AddSubtitle(ctx context.Context, sub Subtitle) (int, error)
	// SubtitleSync is how the added track id was lined up with the video
	// (Subtitle.AutoSync); the zero value for any other track.
	SubtitleSync(id int) SubtitleSync

	// SetNowPlaying names what plays, for the OS's media controls.
	SetNowPlaying(np NowPlaying) error
	// SystemCaptions reports whether the OS asks for captions.
	SystemCaptions() bool
}

// Sink is where an Engine sends what it observes: the frontend's events and
// the progress reports. The host builds it from the app's emitter and
// ReportTo.
type Sink interface {
	// State is sent whenever anything but the time changes (EventState).
	State(State)
	// Time is sent at most every TimeEvery while playing (EventTime).
	Time(Time)
	// Ended is sent when a file ends by itself (EventEnded).
	Ended(Ended)
	// Report is sent for a Watching file (Report's doc says when).
	Report(Report)
}
