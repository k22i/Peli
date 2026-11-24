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
	"log/slog"
	"math"
	"sync"
	"time"

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

// Timings are vars so tests can shorten them; the values are the spike's.
var (
	// idleAfter is how long a Grabber is kept after the last thumbnail made
	// for a hover, so dragging back and forth doesn't reopen it: a seek, a
	// screenshot and a close is three round trips to the CDN.
	idleAfter = 30 * time.Second
	// fillDelay is how long previews have been asked for before the fill
	// starts. The spike's "30 s of steady playback": by then the player is
	// buffered past the first minute and the fill's thumbnails are behind
	// the viewer rather than ahead of them.
	fillDelay = 30 * time.Second
	// fillEvery spaces the fill's thumbnails out: one per two seconds is a
	// few hundred kilobytes a second, which the spike found the CDN takes.
	fillEvery = 2 * time.Second
	// fillCap is how many thumbnails the fill makes at most: ~350 MB on a
	// 2.5-hour remux, against ~3.3 GB for a whole-film grid.
	fillCap = 100
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

	// work serialises every use of the Grabber (opening, grabbing, closing),
	// so the CDN sees one decode at a time even while the fill and a hover's
	// request overlap.
	work sync.Mutex
	// mu guards the session below. It is never held while taking work, so
	// the two locks can't deadlock.
	mu sync.Mutex
	// req is the file previews are being made for; zero when none is begun.
	req Request
	// ctx is the current session's; nil means no session is begun.
	ctx    context.Context
	cancel context.CancelFunc
	// g is the open Grabber, or nil (not opened yet, closed while idle, or
	// dropped after the CDN pushed back).
	g Grabber
	// cache holds the thumbnails made for this file, keyed by bucket start.
	cache map[float64]Thumb
	// failures counts the Grabs that failed in a row: two stop previews for
	// this file (the spike's back-off, from an HTTP 429 or a refused
	// connection).
	failures int
	// stopped says previews for this file are off, after the Grabber
	// wouldn't open or the CDN pushed back.
	stopped bool
	// filling says the background fill's goroutine is still running, so the
	// idle close stays out of its way.
	filling bool
	// want is the ticket of the newest At: an older one that gets to work
	// last finds itself replaced.
	want uint64
	// idle closes the Grabber once no thumbnail has been made for idleAfter.
	idle *time.Timer
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
	s.End()
	if req.Playing.URL == "" || req.Duration <= 0 {
		return ErrUnavailable
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.req = req
	s.ctx, s.cancel = ctx, cancel
	s.cache = map[float64]Thumb{}
	s.failures = 0
	s.stopped = false
	s.filling = req.Fill
	s.mu.Unlock()
	if req.Fill {
		go s.fill(ctx)
	}
	return nil
}

// At returns the thumbnail for t's bucket, from the cache or made now. It
// blocks until made; a newer At makes an older one that hasn't started
// return ErrStale.
func (s *Service) At(t float64) (Thumb, error) {
	b := bucket(t)
	s.mu.Lock()
	if s.ctx == nil || s.stopped {
		s.mu.Unlock()
		return Thumb{}, ErrUnavailable
	}
	if th, ok := s.cache[b]; ok {
		s.mu.Unlock()
		return th, nil
	}
	// The ticket is taken before queueing for work: whoever queued last is
	// the hover the user is on now, and the ones behind it are wasted reads.
	s.want++
	ticket := s.want
	s.mu.Unlock()

	s.work.Lock()
	defer s.work.Unlock()
	s.mu.Lock()
	replaced := s.want != ticket
	th, cached := s.cache[b]
	gone := s.ctx == nil || s.stopped
	ctx := s.ctx
	s.mu.Unlock()
	switch {
	case replaced:
		return Thumb{}, ErrStale
	case cached:
		// The fill made this bucket while this At waited: nothing to make.
		return th, nil
	case gone:
		return Thumb{}, ErrUnavailable
	}
	return s.make(ctx, b)
}

// End stops previews: it closes the Grabber, stops the fill and drops the
// cache. Calling it with nothing begun is fine.
func (s *Service) End() {
	s.mu.Lock()
	cancel, idle := s.cancel, s.idle
	s.cancel, s.idle = nil, nil
	s.mu.Unlock()
	if cancel != nil {
		cancel()
	}
	if idle != nil {
		idle.Stop()
	}

	// Taking work waits for a Grab in flight, so the Grabber isn't closed
	// under it.
	s.work.Lock()
	s.dropGrabber()
	s.work.Unlock()

	s.mu.Lock()
	s.req = Request{}
	s.ctx = nil
	s.cache = nil
	s.failures = 0
	s.stopped = true
	s.filling = false
	s.mu.Unlock()
}

// bucket rounds t down to the start of its thumbnail's bucket, never below 0.
func bucket(t float64) float64 {
	b := math.Floor(t/BucketSeconds) * BucketSeconds
	if b < 0 || math.IsNaN(b) {
		return 0
	}
	return b
}

// make returns b's thumbnail, making it now. The caller holds work.
func (s *Service) make(ctx context.Context, b float64) (Thumb, error) {
	g, err := s.ensure(ctx)
	if err != nil {
		return Thumb{}, err
	}
	// The keyframe at or before the bucket's middle: the nearest one there
	// is to what the bucket's time looks like. Keyframe seeks skip decoding
	// forward, which is where the spike's half second comes from.
	frame, err := g.Grab(ctx, b+BucketSeconds/2)
	if err != nil {
		if ctx.Err() != nil {
			// Our own cancel or a replaced session, not the CDN: nothing to
			// count against the file.
			return Thumb{}, err
		}
		s.mu.Lock()
		s.failures++
		stop := s.failures >= 2
		if stop {
			s.stopped = true
		}
		s.mu.Unlock()
		if stop {
			// Two failures in a row: the CDN is pushing back, so let go of
			// the connection rather than retry against it.
			s.dropGrabber()
			return Thumb{}, ErrUnavailable
		}
		return Thumb{}, err
	}
	s.mu.Lock()
	s.failures = 0
	s.mu.Unlock()

	if frame.Gamma == "pq" || frame.Gamma == "hlg" {
		toneMap(frame.Image, frame.Gamma, frame.Primaries)
	}
	th, err := thumbOf(b, frame.Image)
	if err != nil {
		return Thumb{}, err
	}
	s.mu.Lock()
	if s.cache != nil {
		s.cache[b] = th
	}
	s.mu.Unlock()
	s.resetIdle()
	return th, nil
}

// ensure returns the open Grabber, opening one if none is. The caller holds
// work.
func (s *Service) ensure(ctx context.Context) (Grabber, error) {
	s.mu.Lock()
	g, req := s.g, s.req
	s.mu.Unlock()
	if g != nil {
		return g, nil
	}

	// A smaller copy of the same file is the whole point of the smaller list:
	// a 1–2 GB encode's keyframes cost the CDN a tenth of the remux's. Its
	// duration has to match the playing file's closely, or its thumbnails
	// would be offset from what the viewer sees.
	if len(req.Smaller) > 0 {
		smaller := req.Smaller
		if len(smaller) > MaxSmaller {
			smaller = smaller[:MaxSmaller]
		}
		for i, src := range smaller {
			cand, err := s.open(ctx, src, s.userAgent)
			if err == nil && cand != nil &&
				math.Abs(cand.Duration()-req.Duration) <= DurationTolerance {
				slog.Debug("previews: using a smaller copy", "index", i, "duration", cand.Duration())
				s.setGrabber(cand)
				return cand, nil
			}
			if cand != nil {
				cand.Close()
			}
		}
	}

	g, err := s.open(ctx, req.Playing, s.userAgent)
	if err != nil || g == nil {
		s.mu.Lock()
		s.stopped = true
		s.mu.Unlock()
		return nil, ErrUnavailable
	}
	slog.Debug("previews: using the playing file", "duration", g.Duration())
	s.setGrabber(g)
	return g, nil
}

// setGrabber keeps g as the open one.
func (s *Service) setGrabber(g Grabber) {
	s.mu.Lock()
	s.g = g
	s.mu.Unlock()
}

// dropGrabber closes and forgets the Grabber. The caller holds work.
func (s *Service) dropGrabber() {
	s.mu.Lock()
	g := s.g
	s.g = nil
	s.mu.Unlock()
	if g != nil {
		g.Close()
	}
}

// resetIdle restarts the countdown to closing the Grabber.
func (s *Service) resetIdle() {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.ctx == nil {
		return
	}
	if s.idle != nil {
		s.idle.Stop()
	}
	s.idle = time.AfterFunc(idleAfter, s.closeIdle)
}

// closeIdle drops the Grabber once nothing has asked for a thumbnail for
// idleAfter: a paused player shouldn't hold a second connection open. The
// cache stays, so the next hover reopens and the thumbnails made are still
// there.
func (s *Service) closeIdle() {
	s.mu.Lock()
	filling := s.filling
	s.mu.Unlock()
	if filling {
		return
	}
	s.work.Lock()
	defer s.work.Unlock()
	s.mu.Lock()
	s.idle = nil
	s.mu.Unlock()
	s.dropGrabber()
}

// fill makes the film's thumbnails in the background, in coarse order, so
// the seek bar fills in evenly instead of front to back. It starts after
// fillDelay and spaces its thumbnails out by fillEvery; only a session with
// Fill set has one running.
func (s *Service) fill(ctx context.Context) {
	// Snapshot the timings: one whole fill runs on one set, and a test that
	// shortens them before Begin isn't racing the goroutine afterwards.
	delay, every, limit := fillDelay, fillEvery, fillCap
	defer func() {
		s.mu.Lock()
		s.filling = false
		s.mu.Unlock()
	}()
	wait := time.NewTimer(delay)
	defer wait.Stop()
	select {
	case <-ctx.Done():
		return
	case <-wait.C:
	}

	s.mu.Lock()
	req := s.req
	s.mu.Unlock()

	made := 0
	for _, b := range coarse(req.Duration) {
		if ctx.Err() != nil || s.isStopped() {
			return
		}
		s.mu.Lock()
		_, cached := s.cache[b]
		s.mu.Unlock()
		if cached {
			// A hover already made this one: it doesn't count against the
			// cap, since the point of the cap is the bytes fetched.
			continue
		}

		// Waiting for work lets a hover's At jump the queue: it takes the
		// lock between two of these thumbnails.
		s.work.Lock()
		if ctx.Err() != nil || s.isStopped() {
			s.work.Unlock()
			return
		}
		th, err := s.make(ctx, b)
		s.work.Unlock()
		if err != nil {
			if ctx.Err() != nil || errors.Is(err, ErrUnavailable) {
				return
			}
			// One bad seek: the failures counter decides, and two in a row
			// sets stopped, which the top of the loop sees.
			continue
		}
		made++
		s.emit(EventThumb, th)
		if made >= limit {
			return
		}
		gap := time.NewTimer(every)
		select {
		case <-ctx.Done():
			gap.Stop()
			return
		case <-gap.C:
		}
	}
}

// isStopped reports whether previews for this file are off.
func (s *Service) isStopped() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.stopped
}

// coarse lists every bucket start in [0, duration), ordered so that any
// prefix covers the whole film evenly: the ends first, then the halves, then
// the quarters. The spike's "coarse" order (spikes/seek-previews/main.go),
// which is what makes a half-filled seek bar useful rather than half a film.
func coarse(duration float64) []float64 {
	var starts []float64
	for i := 0; float64(i)*BucketSeconds < duration; i++ {
		starts = append(starts, float64(i)*BucketSeconds)
	}
	n := len(starts)
	step := 1
	for step*2 < n {
		step *= 2
	}
	seen := make([]bool, n)
	out := make([]float64, 0, n)
	for ; step >= 1; step /= 2 {
		for i := 0; i < n; i += step {
			if !seen[i] {
				seen[i] = true
				out = append(out, starts[i])
			}
		}
	}
	return out
}
