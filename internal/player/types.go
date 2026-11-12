package player

import (
	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/playback"
)

// The state, options, errors and reports live in internal/playback, which
// the iOS build and the rest of the app (watching, tracking, party) import
// without the engine. These keep the engine's code and the bound Service's
// signatures reading as they did; the aliases are the same types.
type (
	State         = playback.State
	Time          = playback.Time
	Track         = playback.Track
	Chapter       = playback.Chapter
	Ended         = playback.Ended
	LoadOptions   = playback.LoadOptions
	SubtitleStyle = playback.SubtitleStyle
	Subtitle      = playback.Subtitle
	Stats         = playback.Stats
	AudioDevice   = playback.AudioDevice
	NowPlaying    = playback.NowPlaying
	Watching      = playback.Watching
	Report        = playback.Report
	Gate          = playback.Gate
)

const (
	EventState = playback.EventState
	EventTime  = playback.EventTime
	EventEnded = playback.EventEnded

	TimeEvery        = playback.TimeEvery
	ReportEvery      = playback.ReportEvery
	MaxSubtitleDelay = playback.MaxSubtitleDelay

	CodeInvalid     = playback.CodeInvalid
	CodeUnavailable = playback.CodeUnavailable
	CodeNotPlaying  = playback.CodeNotPlaying
	CodeSubtitles   = playback.CodeSubtitles

	EndExpired     = playback.EndExpired
	EndUnsupported = playback.EndUnsupported
	EndFailed      = playback.EndFailed

	ReportPlaying = playback.ReportPlaying
	ReportPaused  = playback.ReportPaused
	ReportSeeked  = playback.ReportSeeked
	ReportEnded   = playback.ReportEnded
	ReportStopped = playback.ReportStopped
	ReportStarted = playback.ReportStarted
	ReportResumed = playback.ReportResumed
)

var (
	ErrInvalid     = playback.ErrInvalid
	ErrUnavailable = playback.ErrUnavailable
	ErrNotPlaying  = playback.ErrNotPlaying
	ErrSubtitles   = playback.ErrSubtitles

	SubtitleScales = playback.SubtitleScales
	SubtitleFonts  = playback.SubtitleFonts
	SubtitleEdges  = playback.SubtitleEdges
)

// MarshalError gives the frontend an error's code.
func MarshalError(err error) []byte { return playback.MarshalError(err) }

func init() {
	application.RegisterEvent[State](EventState)
	application.RegisterEvent[Time](EventTime)
	application.RegisterEvent[Ended](EventEnded)
}
