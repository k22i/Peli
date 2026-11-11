package player

import (
	"errors"
	"math"
	"path/filepath"
	"testing"

	"github.com/k22i/Sinag/internal/streams"
)

// A file plays at normal speed, whatever the last one played at.
func TestSpeedResetsEachLoad(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/clip.mp4")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { st := s.Snapshot(); return !st.Loading && st.Duration > 0 })
	if err := s.SetPaused(true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpeed(2); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "speed 2", func(*recorder) bool { return s.Snapshot().Speed == 2 })
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "speed 1", func(*recorder) bool { return s.Snapshot().Speed == 1 })
}

// , and . step a frame and stay paused, a file playing pausing first.
func TestFrameStep(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/clip.mp4")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Start: 1}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { st := s.Snapshot(); return !st.Loading && st.Duration > 0 })
	if err := s.SetPaused(true); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "a pause", func(*recorder) bool { st := s.Snapshot(); return st.Paused && !st.Seeking })
	if d := s.frameDuration(); math.Abs(d-1.0/24) > 0.002 {
		t.Errorf("frame duration %v, want 1/24 s", d)
	}
	at := s.Snapshot().Position
	if err := s.FrameStep(false); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "a frame on", func(*recorder) bool {
		st := s.Snapshot()
		return !st.Seeking && st.Position > at+0.02 && st.Position < at+0.1
	})
	if err := s.FrameStep(true); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "a frame back", func(*recorder) bool {
		st := s.Snapshot()
		return !st.Seeking && math.Abs(st.Position-at) < 0.02
	})
	if !s.Snapshot().Paused {
		t.Error("playing after frame steps, want paused")
	}
	if err := s.SetPaused(false); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "playing", func(*recorder) bool { return !s.Snapshot().Paused })
	if err := s.FrameStep(false); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "paused by a frame step", func(*recorder) bool { return s.Snapshot().Paused })
}

// Through a gate a frame step is a pause and a seek a frame on, which the
// gate may refuse or move.
func TestFrameStepGated(t *testing.T) {
	s := NewService("test")
	g := &gateCalls{}
	GateWith(s, g)
	s.mu.Lock()
	s.state.Position = 10
	s.mu.Unlock()
	if err := s.FrameStep(false); err != nil {
		t.Errorf("refused: %v", err)
	}
	if len(g.calls) != 1 || g.calls[0] != "pause" {
		t.Errorf("refused pause went on: %v", g.calls)
	}
	g.allow, g.seekTo = true, 42
	if err := s.FrameStep(true); !errors.Is(err, ErrNotPlaying) {
		t.Errorf("allowed: %v", err)
	}
	if got := g.seeks[len(g.seeks)-1]; math.Abs(got-(10-1.0/24)) > 1e-9 {
		t.Errorf("asked to seek to %v, want a frame back from 10", got)
	}
}

func TestLoopEnd(t *testing.T) {
	if got := loopEnd("no"); got != nil {
		t.Errorf("no: %v", *got)
	}
	if got := loopEnd("12.500000"); got == nil || *got != 12.5 {
		t.Errorf("12.500000: %v", got)
	}
	if got := loopEnd(nil); got != nil {
		t.Errorf("nil: %v", *got)
	}
}

// An A–B loop plays from A to B over and over, until it's cleared; a new
// file starts without it.
func TestLoop(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/clip.mp4")
	if err := s.SetLoop(2, 1); !errors.Is(err, ErrInvalid) {
		t.Errorf("B before A: %v, want ErrInvalid", err)
	}
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { st := s.Snapshot(); return !st.Loading && st.Duration > 0 })
	if err := s.SetLoop(0.5, 1.5); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the loop's ends", func(*recorder) bool {
		st := s.Snapshot()
		return st.LoopA != nil && *st.LoopA == 0.5 && st.LoopB != nil && *st.LoopB == 1.5
	})
	// Played past B, it goes back to A rather than on to the end.
	r.waitFor(t, "a jump back to A", func(r *recorder) bool {
		for i := 1; i < len(r.times); i++ {
			if r.times[i-1].Position > 1.2 && r.times[i].Position < 1 {
				return true
			}
		}
		return false
	})
	if err := s.SetLoop(-1, -1); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "no loop", func(*recorder) bool { st := s.Snapshot(); return st.LoopA == nil && st.LoopB == nil })
	if err := s.SetLoop(1, -1); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "A alone", func(*recorder) bool { st := s.Snapshot(); return st.LoopA != nil && st.LoopB == nil })
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "a new file without it", func(*recorder) bool {
		st := s.Snapshot()
		return !st.Loading && st.LoopA == nil
	})
}

// A watch party's gate is asked before a loop is set, not when it's
// cleared.
func TestLoopGated(t *testing.T) {
	s := NewService("test")
	g := &gateCalls{}
	GateWith(s, g)
	if err := s.SetLoop(1, 2); err != nil {
		t.Errorf("refused: %v", err)
	}
	if err := s.SetLoop(-1, -1); !errors.Is(err, ErrNotPlaying) {
		t.Errorf("clearing: %v", err)
	}
	if len(g.calls) != 1 || g.calls[0] != "loop" {
		t.Errorf("calls = %v, want one loop", g.calls)
	}
}
