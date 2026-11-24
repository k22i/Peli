// Package previews makes the player's seek-bar thumbnails
// (docs/spikes/seek-previews.md). A second, headless libmpv (a Grabber,
// from the platform's player package) opens a copy of the file that plays,
// seeks to keyframes and hands back small frames, which this package turns
// into JPEG thumbnails, one per 10-second bucket.
//
// Only for debrid streams (the frontend decides): never torrents, never
// plain links. It must stay gentle with the debrid CDN: one Grabber and one
// request at a time, the newest request wins, and the first sign of the
// CDN pushing back stops previews for that file.
package previews

import (
	"context"
	"errors"
	"image"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/streams"
)

// EventThumb carries a Thumb made by the background fill, so the seek bar
// can show the nearest one it has at once.
const EventThumb = "previews:thumb"

const (
	// BucketSeconds is how far apart thumbnails are: At rounds down to it.
	BucketSeconds = 10.0
	// Width is a thumbnail's width in pixels; the height keeps the aspect.
	Width = 320
	// MaxSmaller is how many smaller copies Begin tries before Playing.
	MaxSmaller = 3
	// DurationTolerance is how far (seconds) a smaller copy's duration may
	// be from the playing file's for its thumbnails to be used. The spike
	// found copies a minute or more apart that were cut through the film.
	DurationTolerance = 2.0
)

var (
	// ErrUnavailable: no previews for this file (none begun, the Grabber
	// couldn't open, or the CDN pushed back and previews stopped).
	ErrUnavailable = errors.New("previews: unavailable")
	// ErrStale: a newer At replaced this one before it ran.
	ErrStale = errors.New("previews: replaced by a newer request")
)

// Frame is one decoded keyframe, already scaled to Width.
type Frame struct {
	Image *image.NRGBA
	// At is the frame's own time in seconds (the keyframe at or before the
	// time asked for).
	At float64
	// Gamma and Primaries are mpv's video-params/gamma and /primaries:
	// "pq" or "hlg" frames are HDR and get tone mapped (tonemap.go).
	Gamma, Primaries string
}

// Grabber is one headless decoder on one file. It is used from one
// goroutine at a time.
type Grabber interface {
	// Duration is the file's length in seconds, known once opened.
	Duration() float64
	// Grab seeks to the keyframe at or before sec and returns it. It returns
	// ctx's error if ctx ends first.
	Grab(ctx context.Context, sec float64) (Frame, error)
	// Close frees the decoder and its connection.
	Close()
}

// Opener opens a Grabber on source, sending userAgent when source names
// none. Desktop: player.OpenPreview; iOS: iosplayer.OpenPreview.
type Opener func(ctx context.Context, source streams.Source, userAgent string) (Grabber, error)

// Request is what Begin makes previews for.
type Request struct {
	// Playing is the resolved debrid link the player plays.
	Playing streams.Source `json:"playing"`
	// Smaller are resolved links to smaller cached copies of the same film
	// or episode, smallest first. The first (of at most MaxSmaller) whose
	// duration is within DurationTolerance of Duration is used instead of
	// Playing; when none is, Playing is.
	Smaller []streams.Source `json:"smaller"`
	// Duration is the playing file's length in seconds.
	Duration float64 `json:"duration"`
	// Fill makes up to 100 thumbnails ahead in the background, spread over
	// the whole film. Off on iOS.
	Fill bool `json:"fill"`
}

// Thumb is one thumbnail.
type Thumb struct {
	// At is its bucket's start in seconds: a multiple of BucketSeconds.
	At float64 `json:"at"`
	// URL is the JPEG as a data URL ("data:image/jpeg;base64,…").
	URL string `json:"url"`
	W   int    `json:"w"`
	H   int    `json:"h"`
}

// Service is the Wails service the player screen asks for thumbnails.
type Service struct {
	open      Opener
	userAgent string
	emit      func(name string, data any)
	// TODO(previews worker): state.
}

// NewService returns a Service that opens Grabbers with open. version goes
// in the User-Agent, as the player's does.
func NewService(open Opener, version string) *Service {
	return &Service{
		open:      open,
		userAgent: "Peli/" + version + " (+https://github.com/k22i/Peli)",
		emit:      func(string, any) {},
	}
}

func (s *Service) ServiceStartup(context.Context, application.ServiceOptions) error {
	if app := application.Get(); app != nil {
		s.emit = func(name string, data any) { app.Event.Emit(name, data) }
	}
	return nil
}

func (s *Service) ServiceShutdown() error {
	s.End()
	return nil
}

// Begin starts previews for a file: it forgets the last file's, and opens
// nothing yet (the first At or the fill opens the Grabber).
func (s *Service) Begin(req Request) error {
	return ErrUnavailable // TODO(previews worker)
}

// At returns the thumbnail for t's bucket, from the cache or made now. It
// blocks until made; a newer At makes an older one that hasn't started
// return ErrStale.
func (s *Service) At(t float64) (Thumb, error) {
	return Thumb{}, ErrUnavailable // TODO(previews worker)
}

// End stops previews: it closes the Grabber, stops the fill and drops the
// cache. Calling it with nothing begun is fine.
func (s *Service) End() {
	// TODO(previews worker)
}
