//go:build ios

package player

import (
	"context"
	"fmt"
	"math"
	"net/url"
	"path/filepath"
	"sync"
	"sync/atomic"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
)

// This is the iOS build of Service (ADR-0055). The frontend's bindings are
// generated on the desktop, from the libmpv Service in player.go, and a bound
// method's id is a hash of its package, type and name; so the iOS app binds a
// Service of the same name here, with the same exported methods (a test
// compares the two lists). None of libmpv, AppKit or the video host is
// compiled in.
//
// Until the iOS engine exists (Phase 5: libmpv in a UIKit view under the
// transparent webview), every call fails with ErrNotYet, which the frontend
// reads as "unavailable". UseEngine hands the Service that engine; the
// playback.Engine controls then reach it, and the Picture & sound sheet's
// adjustments reach it too when it has them (iosplayer does): picture,
// framing, quality, sound, audio and audio delay. Still desktop-only are the
// mini player, screenshots, loops, frame stepping, fullscreen and the audio
// devices, which keep failing with ErrDesktopOnly.

// ErrNotYet means there is no engine to play with yet.
var ErrNotYet = fmt.Errorf("%w: the player isn't available on this device yet", ErrUnavailable)

// ErrDesktopOnly means the control only exists in the desktop player.
var ErrDesktopOnly = fmt.Errorf("%w: not on this device", ErrUnavailable)

// Service is the Wails service the frontend calls to play a stream.
type Service struct {
	mu     sync.Mutex
	engine playback.Engine
	emit   func(name string, data any)
	report func(Report)
	// gate is asked before the user's pauses, seeks and speed changes: a
	// watch party (ADR-0051). Nil until GateWith.
	gate atomic.Pointer[Gate]
}

// NewService returns a Service with no engine. version is the desktop
// engine's User-Agent and is unused here.
func NewService(version string) *Service {
	return &Service{emit: func(string, any) {}}
}

// UseEngine hands the Service the engine that plays. It isn't a method, so
// Wails doesn't bind it.
func UseEngine(s *Service, e playback.Engine) {
	s.mu.Lock()
	s.engine = e
	s.mu.Unlock()
	if v, ok := e.(interface{ OnSystemVolume(func(float64)) }); ok {
		v.OnSystemVolume(func(level float64) {
			s.mu.Lock()
			emit := s.emit
			s.mu.Unlock()
			emit(EventSystemVolume, level)
		})
	}
}

// ReportTo sends how far a Watching file got to report, like the desktop
// engine does; the engine's Sink (SinkOf) calls it.
func ReportTo(s *Service, report func(Report)) {
	s.mu.Lock()
	s.report = report
	s.mu.Unlock()
}

// SinkOf is where an engine sends its state, time, endings and reports: they
// become the frontend's events, and ReportTo's function gets the reports. It
// isn't a method, so Wails doesn't bind it.
func SinkOf(s *Service) playback.Sink { return sink{s} }

type sink struct{ s *Service }

func (k sink) State(st State) { k.s.emit(EventState, st) }
func (k sink) Time(t Time)    { k.s.emit(EventTime, t) }
func (k sink) Ended(e Ended)  { k.s.emit(EventEnded, e) }
func (k sink) Report(r Report) {
	k.s.mu.Lock()
	report := k.s.report
	k.s.mu.Unlock()
	if report != nil {
		report(r)
	}
}

// Playing is whether a stream is loaded, from Load until Stop. It isn't a
// method, so Wails doesn't bind it.
func Playing(s *Service) bool {
	e := s.engine_()
	return e != nil && e.Snapshot().Active
}

// ServiceStartup wires the events to the app.
func (s *Service) ServiceStartup(context.Context, application.ServiceOptions) error {
	if app := application.Get(); app != nil {
		s.mu.Lock()
		s.emit = func(name string, data any) { app.Event.Emit(name, data) }
		s.mu.Unlock()
	}
	return nil
}

// ServiceShutdown stops what plays.
func (s *Service) ServiceShutdown() error {
	if e := s.engine_(); e != nil {
		return e.Stop()
	}
	return nil
}

func (s *Service) engine_() playback.Engine {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.engine
}

// with runs do on the engine, or fails with ErrNotYet when there is none.
func (s *Service) with(do func(playback.Engine) error) error {
	e := s.engine_()
	if e == nil {
		return ErrNotYet
	}
	return do(e)
}

func (s *Service) Load(source streams.Source, opts LoadOptions) error {
	if source.URL == "" || !opts.Valid() {
		return ErrInvalid
	}
	return s.with(func(e playback.Engine) error { return e.Load(source, opts) })
}

func (s *Service) Stop() error {
	e := s.engine_()
	if e == nil {
		return nil
	}
	return e.Stop()
}

func (s *Service) Snapshot() State {
	if e := s.engine_(); e != nil {
		return e.Snapshot()
	}
	return State{Volume: 100, Speed: 1, Tracks: []Track{}, Chapters: []Chapter{}, SubtitleSize: "medium"}
}

// GateWith has s ask g before the user's changes. It isn't a method, so
// Wails doesn't bind it.
func GateWith(s *Service, g Gate) { s.gate.Store(&g) }

func (s *Service) gated() Gate {
	if g := s.gate.Load(); g != nil {
		return *g
	}
	return nil
}

// Direct is the player without its gate: what a watch party uses to keep
// playback in step, which mustn't come back to it as the user's.
type Direct struct{ s *Service }

// DirectOf returns s without its gate. It isn't a method, so Wails doesn't
// bind it.
func DirectOf(s *Service) Direct { return Direct{s} }

func (d Direct) Snapshot() State { return d.s.Snapshot() }
func (d Direct) SetPaused(paused bool) error {
	return d.s.with(func(e playback.Engine) error { return e.SetPaused(paused) })
}
func (d Direct) Seek(position float64) error {
	return d.s.with(func(e playback.Engine) error { return e.Seek(position) })
}
func (d Direct) SetSpeed(speed float64) error {
	return d.s.with(func(e playback.Engine) error { return e.SetSpeed(speed) })
}

func (s *Service) SetPaused(paused bool) error {
	if g := s.gated(); g != nil && !g.UserPause(paused) {
		return nil
	}
	return s.with(func(e playback.Engine) error { return e.SetPaused(paused) })
}
func (s *Service) Seek(position float64) error {
	if position < 0 || math.IsNaN(position) || math.IsInf(position, 0) {
		return ErrInvalid
	}
	if g := s.gated(); g != nil {
		to, ok := g.UserSeek(position)
		if !ok {
			return nil
		}
		position = to
	}
	return s.with(func(e playback.Engine) error { return e.Seek(position) })
}

// SeekBy with a gate is a Seek to where delta lands, as on the desktop.
func (s *Service) SeekBy(delta float64) error {
	if math.IsNaN(delta) || math.IsInf(delta, 0) {
		return ErrInvalid
	}
	if s.gated() != nil {
		return s.Seek(math.Max(0, s.Snapshot().Position+delta))
	}
	return s.with(func(e playback.Engine) error { return e.SeekBy(delta) })
}
func (s *Service) Scrub(position float64) error {
	if position < 0 || math.IsNaN(position) || math.IsInf(position, 0) {
		return ErrInvalid
	}
	if g := s.gated(); g != nil {
		g.UserScrub()
	}
	return s.with(func(e playback.Engine) error { return e.Scrub(position) })
}
func (s *Service) SetVolume(volume float64) error {
	return s.with(func(e playback.Engine) error { return e.SetVolume(volume) })
}
func (s *Service) SetMuted(muted bool) error {
	return s.with(func(e playback.Engine) error { return e.SetMuted(muted) })
}
func (s *Service) SetSpeed(speed float64) error {
	if speed < 0.25 || speed > 4 || math.IsNaN(speed) {
		return ErrInvalid
	}
	if g := s.gated(); g != nil && !g.UserSpeed(speed) {
		return nil
	}
	return s.with(func(e playback.Engine) error { return e.SetSpeed(speed) })
}
func (s *Service) SetAudioTrack(id int) error {
	return s.with(func(e playback.Engine) error { return e.SetAudioTrack(id) })
}
func (s *Service) SetSubtitleTrack(id int) error {
	return s.with(func(e playback.Engine) error { return e.SetSubtitleTrack(id) })
}
func (s *Service) SetSecondarySubtitleTrack(id int) error {
	return s.with(func(e playback.Engine) error { return e.SetSecondarySubtitleTrack(id) })
}
func (s *Service) SetSubtitleDelay(delay float64) error {
	return s.with(func(e playback.Engine) error { return e.SetSubtitleDelay(delay) })
}
func (s *Service) SetSubtitleSize(size string) error {
	return s.with(func(e playback.Engine) error { return e.SetSubtitleSize(size) })
}
func (s *Service) SetSubtitleStyle(style SubtitleStyle) error {
	return s.with(func(e playback.Engine) error { return e.SetSubtitleStyle(style) })
}
func (s *Service) SetNowPlaying(np NowPlaying) error {
	return s.with(func(e playback.Engine) error { return e.SetNowPlaying(np) })
}

func (s *Service) AddSubtitle(ctx context.Context, sub Subtitle) (int, error) {
	e := s.engine_()
	if e == nil {
		return 0, ErrNotYet
	}
	// A subtitle saved with a download (ADR-0064): only inside a download's
	// subs folder, handed to the engine as its real path.
	if isFileURL(sub.URL) {
		file, err := downloadSubtitlePath(sub.URL)
		if err != nil {
			return 0, ErrInvalid
		}
		sub.URL = (&url.URL{Scheme: "file", Path: filepath.ToSlash(file)}).String()
	}
	return e.AddSubtitle(ctx, sub)
}

func (s *Service) SystemCaptions() bool {
	if e := s.engine_(); e != nil {
		return e.SystemCaptions()
	}
	return false
}

// The rest is the desktop player's: the frontend hides these controls on a
// touch device, and the bindings still resolve.

func (s *Service) FrameStep(back bool) error        { return ErrDesktopOnly }
func (s *Service) SetLoop(a, b float64) error       { return ErrDesktopOnly }
func (s *Service) SetFullscreen(on bool) error      { return ErrDesktopOnly }
func (s *Service) SetMini(on bool) error            { return ErrDesktopOnly }
func (s *Service) ShowScreenshot(path string) error { return ErrDesktopOnly }
func (s *Service) Screenshot(subtitles bool) (string, error) {
	return "", ErrDesktopOnly
}
func (s *Service) AudioDevices() ([]AudioDevice, error) { return nil, ErrDesktopOnly }

// Stats is the engine's when it reads them (iosplayer does, for the touch
// player's More menu, #130).
func (s *Service) Stats() (Stats, error) {
	if e, ok := s.engine_().(interface{ Stats() (Stats, error) }); ok {
		return e.Stats()
	}
	return Stats{}, ErrDesktopOnly
}

// The touch player's native controls (#131), when the engine has them
// (iosplayer does).

type touchControls interface {
	SetBrightness(v float64) error
	Brightness() float64
	SetSystemVolume(v float64) error
	SystemVolume() float64
	SetImmersive(on bool) error
	SetPanscan(v float64) error
	SetVideoInset(rightPx int) error
}

func (s *Service) touch() touchControls {
	t, _ := s.engine_().(touchControls)
	return t
}

func (s *Service) SetBrightness(v float64) error {
	if t := s.touch(); t != nil {
		return t.SetBrightness(v)
	}
	return ErrNotYet
}

func (s *Service) Brightness() float64 {
	if t := s.touch(); t != nil {
		return t.Brightness()
	}
	return -1
}

func (s *Service) SetSystemVolume(v float64) error {
	if t := s.touch(); t != nil {
		return t.SetSystemVolume(v)
	}
	return ErrNotYet
}

func (s *Service) SystemVolume() float64 {
	if t := s.touch(); t != nil {
		return t.SystemVolume()
	}
	return -1
}

func (s *Service) SetImmersive(on bool) error {
	if t := s.touch(); t != nil {
		return t.SetImmersive(on)
	}
	return ErrNotYet
}

func (s *Service) SetPanscan(v float64) error {
	if t := s.touch(); t != nil {
		return t.SetPanscan(v)
	}
	return ErrNotYet
}

// SetVideoInset shifts the picture left for the docked watch party's
// sidebar. Like the desktop's, it isn't gated; with no engine there is
// nothing to shift.
func (s *Service) SetVideoInset(rightPx int) error {
	if t := s.touch(); t != nil {
		return t.SetVideoInset(rightPx)
	}
	return nil
}

// The Picture & sound sheet's adjustments, when the engine applies them
// (iosplayer does): the picture, the framing, the quality, the sound, this
// device's output and the session's audio delay.
type adjustControls interface {
	SetPicture(store.Picture) error
	SetFraming(store.Framing) error
	SetQuality(store.Quality) error
	SetSound(store.Sound) error
	SetAudio(store.Audio) error
	SetAudioDelay(float64) error
}

func (s *Service) SetPicture(picture store.Picture) error {
	if e, ok := s.engine_().(adjustControls); ok {
		return e.SetPicture(picture)
	}
	return ErrNotYet
}

func (s *Service) SetFraming(framing store.Framing) error {
	if e, ok := s.engine_().(adjustControls); ok {
		return e.SetFraming(framing)
	}
	return ErrNotYet
}

func (s *Service) SetQuality(quality store.Quality) error {
	if e, ok := s.engine_().(adjustControls); ok {
		return e.SetQuality(quality)
	}
	return ErrNotYet
}

func (s *Service) SetSound(sound store.Sound) error {
	if e, ok := s.engine_().(adjustControls); ok {
		return e.SetSound(sound)
	}
	return ErrNotYet
}

func (s *Service) SetAudio(audio store.Audio) error {
	if e, ok := s.engine_().(adjustControls); ok {
		return e.SetAudio(audio)
	}
	return ErrNotYet
}

func (s *Service) SetAudioDelay(delay float64) error {
	if e, ok := s.engine_().(adjustControls); ok {
		return e.SetAudioDelay(delay)
	}
	return ErrNotYet
}

// The Service is itself an Engine when it has one to forward to; this keeps
// its controls in step with the interface.
var _ playback.Engine = (*Service)(nil)
