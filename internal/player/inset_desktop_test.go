//go:build !ios

package player

import "testing"

// The inset isn't a party control: a refusing gate is never asked, and the
// call needs no session.
func TestSetVideoInsetIsNotGated(t *testing.T) {
	s := NewService("test")
	g := &gateCalls{}
	GateWith(s, g)
	if err := s.SetVideoInset(352); err != nil {
		t.Fatalf("SetVideoInset: %v", err)
	}
	if len(g.calls) != 0 {
		t.Errorf("the gate was asked: %v", g.calls)
	}
	s.mu.Lock()
	got := s.inset
	s.mu.Unlock()
	if got != 352 {
		t.Errorf("inset = %d, want 352", got)
	}
	s.SetVideoInset(-5)
	s.mu.Lock()
	got = s.inset
	s.mu.Unlock()
	if got != 0 {
		t.Errorf("a negative inset kept as %d", got)
	}
}
