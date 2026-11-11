package player

import (
	"errors"
	"testing"
)

type gateCalls struct {
	allow  bool
	seekTo float64
	calls  []string
	seeks  []float64
}

func (g *gateCalls) UserPause(paused bool) bool {
	g.calls = append(g.calls, "pause")
	return g.allow
}
func (g *gateCalls) UserSeek(position float64) (float64, bool) {
	g.calls = append(g.calls, "seek")
	g.seeks = append(g.seeks, position)
	return g.seekTo, g.allow
}
func (g *gateCalls) UserSpeed(float64) bool { g.calls = append(g.calls, "speed"); return g.allow }
func (g *gateCalls) UserScrub()             { g.calls = append(g.calls, "scrub") }
func (g *gateCalls) UserLoop() bool         { g.calls = append(g.calls, "loop"); return g.allow }

// The gate is asked before the user's changes reach mpv: refused, nothing
// happens and nothing fails; allowed, they go on (here to no session).
func TestGate(t *testing.T) {
	s := NewService("test")
	g := &gateCalls{}
	GateWith(s, g)
	for name, call := range map[string]func() error{
		"pause": func() error { return s.SetPaused(true) },
		"seek":  func() error { return s.Seek(10) },
		"speed": func() error { return s.SetSpeed(2) },
	} {
		if err := call(); err != nil {
			t.Errorf("refused %s: %v", name, err)
		}
	}
	g.allow, g.seekTo = true, 42
	if err := s.Seek(10); !errors.Is(err, ErrNotPlaying) {
		t.Errorf("allowed seek: %v", err)
	}
	// SeekBy is a seek to where it lands.
	s.mu.Lock()
	s.state.Position = 100
	s.mu.Unlock()
	s.SeekBy(-30)
	if got := g.seeks[len(g.seeks)-1]; got != 70 {
		t.Errorf("SeekBy asked the gate for %v", got)
	}
	s.Scrub(5)
	if g.calls[len(g.calls)-1] != "scrub" {
		t.Errorf("calls = %v", g.calls)
	}
	// The party's own corrections don't come back to it.
	before := len(g.calls)
	d := DirectOf(s)
	d.SetPaused(true)
	d.Seek(1)
	d.SetSpeed(1.05)
	if len(g.calls) != before {
		t.Errorf("Direct went through the gate: %v", g.calls[before:])
	}
}
