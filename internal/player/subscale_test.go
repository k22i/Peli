//go:build !ios

package player

import (
	"path/filepath"
	"testing"

	"github.com/k22i/Peli/internal/streams"
)

// A Blu-ray (PGS) subtitle is a picture: mpv would stretch it by sub-scale
// and blur it, so the style's size waits for a text track. testdata/
// picture-subs.mkv has an English PGS track (1, default) and an English
// SubRip one (2).
func TestPictureSubtitlesAreNotScaled(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	style := SubtitleStyle{Font: "sans", Size: 150, Color: "#FFFFFF", Edge: "outline", Backdrop: 60}
	path, _ := filepath.Abs("testdata/picture-subs.mkv")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Captions: "on", SubtitleLanguage: "en", SubtitleStyle: &style}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { st := s.Snapshot(); return !st.Loading && len(st.Tracks) > 0 })
	if err := s.SetPaused(true); err != nil {
		t.Fatal(err)
	}
	scale := func() string {
		v, err := s.current().m.getString("sub-scale")
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
	main := func(id int) bool {
		for _, tr := range s.Snapshot().Tracks {
			if tr.ID == id && tr.Type == "sub" {
				return tr.Selected
			}
		}
		return false
	}
	r.waitFor(t, "the PGS track", func(*recorder) bool { return main(1) })
	r.waitFor(t, "sub-scale 1 for pictures", func(*recorder) bool { return scale() == "1.000000" })

	// The text track gets the style's size; a style change then applies.
	if err := s.SetSubtitleTrack(2); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "sub-scale 1.5 for text", func(*recorder) bool { return main(2) && scale() == "1.500000" })
	style.Size = 120
	if err := s.SetSubtitleStyle(style); err != nil {
		t.Fatal(err)
	}
	if got := scale(); got != "1.200000" {
		t.Errorf("style at 120 over text: sub-scale %s", got)
	}

	// Back to pictures: 1 again, and a size picked meanwhile waits.
	if err := s.SetSubtitleTrack(1); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "sub-scale 1 again", func(*recorder) bool { return main(1) && scale() == "1.000000" })
	if err := s.SetSubtitleSize("large"); err != nil {
		t.Fatal(err)
	}
	if got := scale(); got != "1.000000" {
		t.Errorf("size large over pictures: sub-scale %s", got)
	}
	if err := s.SetSubtitleTrack(2); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "large for text", func(*recorder) bool { return main(2) && scale() == "1.350000" })
}
