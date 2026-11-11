package player

import (
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
