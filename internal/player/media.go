package player

import (
	"log/slog"
	"math"
	"sync"
)

// The OS's media controls (#67): macOS's Now Playing and media keys, MPRIS
// on Linux, Windows' System Media Transport Controls. They show what plays
// and send play, pause and seeks back, which the service runs like the
// screen's own controls; the screen follows through player:state.

// NowPlaying names what plays, for the OS's media controls: the title, and
// for an episode its code and name ("S1E2 · Pilot").
type NowPlaying struct {
	Title    string `json:"title"`
	Subtitle string `json:"subtitle"`
}

// mediaState is what the media controls show.
type mediaState struct {
	NowPlaying
	Paused   bool
	Position float64
	Duration float64
	Speed    float64
	// Seeks counts the jumps in position: the controls extrapolate it from
	// the speed, and a change says to look again.
	Seeks int
}

// mediaControls are one OS's media controls. show is called off the
// player's event loop, one call at a time.
type mediaControls interface {
	// show puts st in the controls, and takes them away for nil, so the
	// media keys go to other apps again.
	show(st *mediaState)
}

// mediaCommand is what the media controls ask for.
type mediaCommand int

const (
	mediaPlay mediaCommand = iota + 1
	mediaPause
	mediaToggle
	// mediaSeekBy moves by a value in seconds, back when it's negative.
	mediaSeekBy
	// mediaSeekTo goes to a value in seconds from the start.
	mediaSeekTo
)

// mediaSkip is how far the controls' skip buttons move, as the screen's.
const mediaSkip = 10

// SetNowPlaying names what plays, for the OS's media controls, until Stop.
// Windows' come from libmpv, which shows mpv's media-title.
func (s *Service) SetNowPlaying(np NowPlaying) error {
	s.mu.Lock()
	s.nowPlaying, s.mediaDirty = np, true
	ses := s.s
	s.mu.Unlock()
	if ses == nil {
		return nil
	}
	if err := ses.m.setProperty("force-media-title", np.mediaTitle()); err != nil {
		return notPlaying(err)
	}
	ses.m.wakeup()
	return nil
}

func (np NowPlaying) mediaTitle() string {
	if np.Subtitle == "" {
		return np.Title
	}
	return np.Title + " · " + np.Subtitle
}

// UseMediaControls has the OS's media controls show what plays, and play,
// pause and seek it. It isn't a method, so Wails doesn't bind it.
func UseMediaControls(s *Service) {
	controls := newMediaControls(s.mediaCommand)
	if controls == nil {
		return
	}
	s.mu.Lock()
	s.media = &latestMedia{controls: controls}
	s.mu.Unlock()
}

// mediaCommand runs what the media controls ask for, like the screen's own
// controls would.
func (s *Service) mediaCommand(c mediaCommand, value float64) {
	var err error
	switch c {
	case mediaPlay:
		err = s.SetPaused(false)
	case mediaPause:
		err = s.SetPaused(true)
	case mediaToggle:
		err = s.command("cycle", "pause")
	case mediaSeekBy:
		err = s.SeekBy(value)
	case mediaSeekTo:
		s.mu.Lock()
		duration := s.state.Duration
		s.mu.Unlock()
		if duration > 0 {
			value = math.Min(value, duration)
		}
		err = s.Seek(math.Max(0, value))
	}
	if err != nil && err != ErrNotPlaying {
		slog.Warn("player: media control failed", "command", c, "error", err)
	}
}

// mediaNow is what the media controls should show, nil for nothing. Call
// with s.mu held.
func (s *Service) mediaNow() *mediaState {
	if s.s == nil || !s.state.Active {
		return nil
	}
	return &mediaState{
		NowPlaying: s.nowPlaying,
		Paused:     s.state.Paused,
		Position:   s.state.Position,
		Duration:   s.state.Duration,
		Speed:      s.state.Speed,
		Seeks:      s.seeks,
	}
}

// latestMedia shows the newest state on its own goroutine, so a slow OS
// call never holds up the event loop, and skips any it was too slow for.
type latestMedia struct {
	controls mediaControls
	mu       sync.Mutex
	next     *mediaState
	pending  bool
	running  bool
}

func (l *latestMedia) show(st *mediaState) {
	l.mu.Lock()
	defer l.mu.Unlock()
	l.next, l.pending = st, true
	if l.running {
		return
	}
	l.running = true
	go func() {
		for {
			l.mu.Lock()
			if !l.pending {
				l.running = false
				l.mu.Unlock()
				return
			}
			st := l.next
			l.next, l.pending = nil, false
			l.mu.Unlock()
			l.controls.show(st)
		}
	}()
}
