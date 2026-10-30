package player

import (
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/k22i/Sinag/internal/streams"
)

// fakeMedia records what the media controls were given.
type fakeMedia struct {
	mu    sync.Mutex
	shown []*mediaState
}

func (f *fakeMedia) show(st *mediaState) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if st != nil {
		c := *st
		st = &c
	}
	f.shown = append(f.shown, st)
}

func (f *fakeMedia) last() *mediaState {
	f.mu.Lock()
	defer f.mu.Unlock()
	if len(f.shown) == 0 {
		return nil
	}
	return f.shown[len(f.shown)-1]
}

func TestMediaControls(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	media := &fakeMedia{}
	s.media = media
	path, _ := filepath.Abs("testdata/clip.mp4")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	if err := s.SetNowPlaying(NowPlaying{Title: "Breaking Bad", Subtitle: "S1E2 · Cat's in the Bag..."}); err != nil {
		t.Fatal(err)
	}
	shows := func(what string, ok func(st *mediaState) bool) {
		t.Helper()
		r.waitFor(t, what, func(*recorder) bool { st := media.last(); return st != nil && ok(st) })
	}
	shows("the title, playing", func(st *mediaState) bool {
		return st.Title == "Breaking Bad" && st.Subtitle == "S1E2 · Cat's in the Bag..." &&
			!st.Paused && st.Duration > 0 && st.Speed == 1
	})
	// libmpv names it too: Windows' controls read media-title.
	if title, err := s.current().m.getString("media-title"); err != nil || title != "Breaking Bad · S1E2 · Cat's in the Bag..." {
		t.Errorf("media-title %q, %v", title, err)
	}

	// The controls' commands run as the screen's would.
	s.mediaCommand(mediaPause, 0)
	shows("paused", func(st *mediaState) bool { return st.Paused })
	s.mediaCommand(mediaToggle, 0)
	shows("playing again", func(st *mediaState) bool { return !st.Paused })
	s.mediaCommand(mediaToggle, 0)
	shows("paused again", func(st *mediaState) bool { return st.Paused })
	seeks := media.last().Seeks
	s.mediaCommand(mediaSeekTo, 99)
	shows("at the end, a jump", func(st *mediaState) bool { return st.Seeks > seeks && st.Position > clipSeconds-0.2 })
	seeks = media.last().Seeks
	s.mediaCommand(mediaSeekBy, -2)
	shows("2 s back", func(st *mediaState) bool { return st.Seeks > seeks && st.Position < clipSeconds-1.5 })
	s.mediaCommand(mediaPlay, 0)
	shows("playing", func(st *mediaState) bool { return !st.Paused })

	// Stopping takes it away, and forgets the title.
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	if st := media.last(); st != nil {
		t.Fatalf("after Stop: %+v, want nil", st)
	}
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	shows("the next file, untitled", func(st *mediaState) bool { return st.Title == "" && st.Duration > 0 })
}

func TestSetNowPlayingWithNothingPlaying(t *testing.T) {
	s, _ := newTestService(t)
	if err := s.SetNowPlaying(NowPlaying{Title: "The Film"}); err != nil {
		t.Fatal(err)
	}
	s.mediaCommand(mediaToggle, 0) // nothing to do, no panic
}

// latestMedia skips states it had no time for, and keeps the order.
func TestLatestMediaShowsTheNewest(t *testing.T) {
	block, started := make(chan struct{}), make(chan struct{})
	slow := &blockingMedia{fakeMedia: &fakeMedia{}, block: block, started: started}
	l := &latestMedia{controls: slow}
	l.show(&mediaState{Position: 1})
	<-started
	for i := 2; i <= 5; i++ {
		l.show(&mediaState{Position: float64(i)})
	}
	l.show(nil)
	close(block)
	for {
		l.mu.Lock()
		running := l.running
		l.mu.Unlock()
		if !running {
			break
		}
		time.Sleep(time.Millisecond)
	}
	slow.mu.Lock()
	defer slow.mu.Unlock()
	if len(slow.shown) != 2 || slow.shown[0].Position != 1 || slow.shown[1] != nil {
		t.Fatalf("shown %v, want the first, then nil", slow.shown)
	}
}

// blockingMedia waits on block in its first show.
type blockingMedia struct {
	*fakeMedia
	block   chan struct{}
	started chan struct{}
}

func (b *blockingMedia) show(st *mediaState) {
	if b.started != nil {
		close(b.started)
		b.started = nil
		<-b.block
	}
	b.fakeMedia.show(st)
}
