package player

import (
	"errors"
	"math"
	"path/filepath"
	"testing"

	"github.com/k22i/Peli/internal/streams"
)

func TestStats(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	if _, err := s.Stats(); !errors.Is(err, ErrNotPlaying) {
		t.Errorf("before Load: %v, want ErrNotPlaying", err)
	}
	path, _ := filepath.Abs("testdata/clip.mp4")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { st := s.Snapshot(); return !st.Loading && st.Duration > 0 })
	got, err := s.Stats()
	if err != nil {
		t.Fatal(err)
	}
	if got.VideoCodec != "h264" || got.Width != 320 || got.Height != 180 {
		t.Errorf("video %q %dx%d, want h264 320x180", got.VideoCodec, got.Width, got.Height)
	}
	if math.Abs(got.FPS-24) > 0.5 {
		t.Errorf("fps %v, want 24", got.FPS)
	}
	if got.AudioCodec != "aac" || got.AudioChannels == 0 {
		t.Errorf("audio %q, %d channels", got.AudioCodec, got.AudioChannels)
	}
	if got.PixelFormat == "" || got.Gamma == "" || got.Renderer != "null" {
		t.Errorf("pixel format %q, gamma %q, renderer %q", got.PixelFormat, got.Gamma, got.Renderer)
	}
	if got.HDRShown || got.DroppedFrames < 0 {
		t.Errorf("%+v", got)
	}
}
