package player

import (
	"errors"
	"image/png"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/k22i/Sinag/internal/streams"
)

func TestScreenshotName(t *testing.T) {
	for _, c := range []struct {
		playing  NowPlaying
		position float64
		want     string
	}{
		{NowPlaying{Title: "Severance", Subtitle: "S1:E2 Half Loop"}, 754.6, "Severance – S1 E2 Half Loop 0.12.34"},
		{NowPlaying{Title: "Dune: Part Two"}, 3725, "Dune Part Two 1.02.05"},
		{NowPlaying{Title: `a/b\c*?"<>|.`}, -3, "a b c 0.00.00"},
		{NowPlaying{}, 5, "Sinag 0.00.05"},
	} {
		if got := screenshotName(c.playing, c.position); got != c.want {
			t.Errorf("screenshotName(%+v, %v) = %q, want %q", c.playing, c.position, got, c.want)
		}
	}
	long := screenshotName(NowPlaying{Title: strings.Repeat("x", 300)}, 0)
	if n := len([]rune(long)); n > 130 {
		t.Errorf("a long title gives a %d-rune name", n)
	}
}

func TestRawImage(t *testing.T) {
	// 2×1 bgr0 with a 12-byte stride: blue, then red.
	img, err := rawImage(map[string]any{
		"w": int64(2), "h": int64(1), "stride": int64(12),
		"data": []byte{255, 0, 0, 0, 0, 0, 255, 0, 9, 9, 9, 9},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got := img.NRGBAAt(0, 0); got.B != 255 || got.R != 0 || got.A != 255 {
		t.Errorf("first pixel %+v, want opaque blue", got)
	}
	if got := img.NRGBAAt(1, 0); got.R != 255 || got.B != 0 {
		t.Errorf("second pixel %+v, want red", got)
	}
	if _, err := rawImage(map[string]any{"w": int64(2), "h": int64(2), "stride": int64(8), "data": []byte{1}}); err == nil {
		t.Error("a short frame was taken")
	}
}

func TestWritePNGNeverReplaces(t *testing.T) {
	dir := t.TempDir()
	img, _ := rawImage(map[string]any{"w": int64(1), "h": int64(1), "stride": int64(4), "data": []byte{0, 0, 0, 0}})
	first, err := writePNG(dir, "shot", img)
	if err != nil {
		t.Fatal(err)
	}
	second, err := writePNG(dir, "shot", img)
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(first) != "shot.png" || filepath.Base(second) != "shot 2.png" {
		t.Errorf("names %q, %q", first, second)
	}
	entries, _ := os.ReadDir(dir)
	if len(entries) != 2 {
		t.Errorf("%d files left, want the two screenshots", len(entries))
	}
}

// Not parallel: it moves the screenshot folder.
func TestScreenshot(t *testing.T) {
	dir := t.TempDir()
	old := screenshotDir
	screenshotDir = func() (string, error) { return filepath.Join(dir, "Sinag"), nil }
	t.Cleanup(func() { screenshotDir = old })

	s, r := newTestService(t)
	if _, err := s.Screenshot(false); !errors.Is(err, ErrNotPlaying) {
		t.Errorf("before Load: %v, want ErrNotPlaying", err)
	}
	path, _ := filepath.Abs("testdata/tracks.mkv")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Start: 1, Captions: "on", SubtitleLanguage: "en"}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { st := s.Snapshot(); return !st.Loading && st.Duration > 0 })
	if err := s.SetPaused(true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetNowPlaying(NowPlaying{Title: "Clip", Subtitle: "S1:E1"}); err != nil {
		t.Fatal(err)
	}
	for _, subtitles := range []bool{false, true} {
		shot, err := s.Screenshot(subtitles)
		if err != nil {
			t.Fatalf("Screenshot(%v): %v", subtitles, err)
		}
		if !strings.HasPrefix(filepath.Base(shot), "Clip – S1 E1 0.00.0") {
			t.Errorf("named %q", filepath.Base(shot))
		}
		f, err := os.Open(shot)
		if err != nil {
			t.Fatal(err)
		}
		cfg, err := png.DecodeConfig(f)
		f.Close()
		if err != nil || cfg.Width != 320 || cfg.Height != 180 {
			t.Errorf("Screenshot(%v): %dx%d, %v; want a 320x180 PNG", subtitles, cfg.Width, cfg.Height, err)
		}
	}
	if err := s.ShowScreenshot(filepath.Join(dir, "elsewhere.png")); !errors.Is(err, ErrInvalid) {
		t.Errorf("showing a file outside the folder: %v, want ErrInvalid", err)
	}
	if err := s.ShowScreenshot(filepath.Join(dir, "Sinag", "..", "x.png")); !errors.Is(err, ErrInvalid) {
		t.Errorf("showing a way out of the folder: %v, want ErrInvalid", err)
	}
}
