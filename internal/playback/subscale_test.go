package playback

import "testing"

func TestSubScaleHoldsPictureSubtitlesAtOne(t *testing.T) {
	t.Parallel()
	text := []Track{{ID: 1, Type: "sub", Codec: "subrip", Selected: true}}
	picture := []Track{{ID: 1, Type: "sub", Codec: "hdmv_pgs_subtitle", Selected: true}}
	scaleOf := func(props [][2]string) string {
		for _, p := range props {
			if p[0] == "sub-scale" {
				return p[1]
			}
		}
		return ""
	}
	var s SubScale
	// A file with a style at 150 %: text until the track-list says.
	if got := scaleOf(s.Load([][2]string{{"sid", "auto"}, {"sub-scale", "1.5"}})); got != "1.5" {
		t.Fatalf("load: sub-scale %q, want 1.5", got)
	}
	if v, ok := s.Tracks(text); ok {
		t.Errorf("text tracks changed the scale to %q", v)
	}
	if v, ok := s.Tracks(picture); !ok || v != "1" || !s.Image() {
		t.Errorf("picture main track: %q, %v; want 1, true", v, ok)
	}
	// A style change while pictures show waits for text.
	if got := scaleOf(s.Props([][2]string{{"sub-font", "Georgia"}, {"sub-scale", "1.2"}})); got != "1" {
		t.Errorf("style over pictures: sub-scale %q, want 1", got)
	}
	if v, ok := s.Tracks(text); !ok || v != "1.2" || s.Image() {
		t.Errorf("back to text: %q, %v; want 1.2, true", v, ok)
	}
	// A second line that is pictures doesn't count; a hidden main still
	// does (HideMainSubtitle comes after).
	second := []Track{{ID: 1, Type: "sub", Codec: "subrip", Selected: true},
		{ID: 2, Type: "sub", Codec: "dvd_subtitle", Secondary: true}}
	if _, ok := s.Tracks(second); ok {
		t.Error("a picture second line changed the scale")
	}
	// The last file's pictures left mpv at 1: a file whose options don't
	// size its subtitles gets the asked-for scale back.
	s.Tracks(picture)
	if got := scaleOf(s.Load([][2]string{{"sid", "auto"}})); got != "1.2" {
		t.Errorf("load without a size: sub-scale %q, want 1.2", got)
	}
}

func TestMainImageSubtitle(t *testing.T) {
	t.Parallel()
	for _, c := range []struct {
		tracks []Track
		want   bool
	}{
		{nil, false},
		{[]Track{{Type: "sub", Codec: "hdmv_pgs_subtitle"}}, false},
		{[]Track{{Type: "sub", Codec: "hdmv_pgs_subtitle", Selected: true}}, true},
		{[]Track{{Type: "sub", Codec: "ass", Selected: true}}, false},
		{[]Track{{Type: "video", Codec: "png", Selected: true}}, false},
	} {
		if got := MainImageSubtitle(c.tracks); got != c.want {
			t.Errorf("MainImageSubtitle(%+v) = %v, want %v", c.tracks, got, c.want)
		}
	}
}
