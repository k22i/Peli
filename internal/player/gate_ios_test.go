//go:build ios

package player

import (
	"testing"

	"github.com/k22i/Peli/internal/playback"
)

// fakeEngine records what reaches it. The embedded Engine is nil: a call the
// tests don't expect panics.
type fakeEngine struct {
	playback.Engine
	pauses []bool
	seeks  []float64
	speeds []float64
	scrubs []float64
	pos    float64
}

func (f *fakeEngine) Snapshot() State {
	var st State
	st.Position = f.pos
	return st
}
func (f *fakeEngine) SetPaused(p bool) error    { f.pauses = append(f.pauses, p); return nil }
func (f *fakeEngine) Seek(p float64) error      { f.seeks = append(f.seeks, p); return nil }
func (f *fakeEngine) Scrub(p float64) error     { f.scrubs = append(f.scrubs, p); return nil }
func (f *fakeEngine) SetSpeed(sp float64) error { f.speeds = append(f.speeds, sp); return nil }

// fakeGate refuses pauses and speeds, moves seeks by seekTo, and counts scrubs.
type fakeGate struct {
	allow  bool
	seekTo float64
	scrubs int
}

func (g *fakeGate) UserPause(bool) bool { return g.allow }
func (g *fakeGate) UserSeek(float64) (float64, bool) {
	return g.seekTo, g.allow
}
func (g *fakeGate) UserSpeed(float64) bool { return g.allow }
func (g *fakeGate) UserScrub()             { g.scrubs++ }
func (g *fakeGate) UserLoop() bool         { return g.allow }

func gated(t *testing.T, g *fakeGate) (*Service, *fakeEngine) {
	t.Helper()
	s := NewService("test")
	e := &fakeEngine{pos: 10}
	UseEngine(s, e)
	GateWith(s, g)
	return s, e
}

func TestGateRefusalKeepsTheEngineUntouched(t *testing.T) {
	s, e := gated(t, &fakeGate{allow: false})
	if err := s.SetPaused(true); err != nil {
		t.Fatal(err)
	}
	if err := s.Seek(30); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSpeed(2); err != nil {
		t.Fatal(err)
	}
	if len(e.pauses)+len(e.seeks)+len(e.speeds) != 0 {
		t.Fatalf("engine was called: %+v", e)
	}
}

func TestGateSeekRewriteIsHonoured(t *testing.T) {
	g := &fakeGate{allow: true, seekTo: 42}
	s, e := gated(t, g)
	if err := s.Seek(30); err != nil {
		t.Fatal(err)
	}
	if err := s.SeekBy(5); err != nil {
		t.Fatal(err)
	}
	if len(e.seeks) != 2 || e.seeks[0] != 42 || e.seeks[1] != 42 {
		t.Fatalf("seeks = %v, want [42 42]", e.seeks)
	}
	if err := s.Scrub(7); err != nil {
		t.Fatal(err)
	}
	if g.scrubs != 1 || len(e.scrubs) != 1 {
		t.Fatalf("scrubs: gate %d, engine %d", g.scrubs, len(e.scrubs))
	}
}

func TestDirectBypassesTheGate(t *testing.T) {
	s, e := gated(t, &fakeGate{allow: false})
	d := DirectOf(s)
	if err := d.SetPaused(true); err != nil {
		t.Fatal(err)
	}
	if err := d.Seek(30); err != nil {
		t.Fatal(err)
	}
	if err := d.SetSpeed(2); err != nil {
		t.Fatal(err)
	}
	if len(e.pauses) != 1 || !e.pauses[0] || len(e.seeks) != 1 || e.seeks[0] != 30 || len(e.speeds) != 1 || e.speeds[0] != 2 {
		t.Fatalf("engine got %+v", e)
	}
	if d.Snapshot().Position != 10 {
		t.Fatalf("snapshot = %+v", d.Snapshot())
	}
}
