//go:build !ios

package player

import (
	"errors"
	"path/filepath"
	"testing"

	"github.com/k22i/Peli/internal/streams"
)

// mpv marks the second subtitle track selected too; main-selection says
// which it is. The main track stays Selected, the second becomes Secondary,
// and audio (whose main-selection is 0) is never second.
func TestTracksTellTheSecondSubtitlesApart(t *testing.T) {
	t.Parallel()
	list := []any{
		map[string]any{"id": int64(1), "type": "audio", "selected": true, "main-selection": int64(0)},
		map[string]any{"id": int64(1), "type": "sub", "selected": true, "main-selection": int64(0), "lang": "en"},
		map[string]any{"id": int64(2), "type": "sub", "selected": true, "main-selection": int64(1), "lang": "ja"},
		map[string]any{"id": int64(3), "type": "sub", "selected": false},
	}
	got := tracks(list)
	want := []struct{ selected, secondary bool }{{true, false}, {true, false}, {false, true}, {false, false}}
	if len(got) != len(want) {
		t.Fatalf("%d tracks, want %d", len(got), len(want))
	}
	for i, w := range want {
		if got[i].Selected != w.selected || got[i].Secondary != w.secondary {
			t.Errorf("track %d: selected %v, secondary %v; want %v, %v", i, got[i].Selected, got[i].Secondary, w.selected, w.secondary)
		}
	}
	st := State{Tracks: got}
	if !st.SecondaryIs(2) || st.SecondaryIs(1) || st.SecondaryIs(3) {
		t.Errorf("SecondaryIs: want only subtitle track 2 (%+v)", got)
	}
}

func TestImageSubtitlesCantBeTheSecondLine(t *testing.T) {
	t.Parallel()
	for codec, want := range map[string]bool{
		"hdmv_pgs_subtitle": true, "dvd_subtitle": true, "dvb_subtitle": true,
		"subrip": false, "ass": false, "webvtt": false, "mov_text": false, "": false,
	} {
		if got := imageSubtitle(codec); got != want {
			t.Errorf("imageSubtitle(%q) = %v, want %v", codec, got, want)
		}
	}
}

// A new file starts without a second line, whatever the last one had.
func TestLoadClearsTheSecondSubtitles(t *testing.T) {
	t.Parallel()
	for _, p := range trackProps(LoadOptions{}) {
		if p[0] == "secondary-sid" && p[1] == "no" {
			return
		}
	}
	t.Error("a load's track properties leave secondary-sid as it was")
}

func TestSecondarySubtitleControls(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	if err := s.SetSecondarySubtitleTrack(2); !errors.Is(err, ErrNotPlaying) {
		t.Fatalf("before Load: got %v, want ErrNotPlaying", err)
	}
	path, _ := filepath.Abs("testdata/tracks.mkv")
	// Captions on in English: track 1 is the main one.
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Captions: "on", SubtitleLanguage: "en"}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { st := s.Snapshot(); return !st.Loading && len(st.Tracks) > 0 })
	if err := s.SetPaused(true); err != nil {
		t.Fatal(err)
	}
	role := func(id int) (main, second bool) {
		for _, tr := range s.Snapshot().Tracks {
			if tr.ID == id && tr.Type == "sub" {
				return tr.Selected, tr.Secondary
			}
		}
		return false, false
	}
	if err := s.SetSubtitleTrack(1); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "main subtitles", func(*recorder) bool { m, _ := role(1); return m })

	// The Japanese track becomes the second line; the main one stays main.
	if err := s.SetSecondarySubtitleTrack(2); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "second subtitles", func(*recorder) bool { _, sec := role(2); return sec })
	if m, sec := role(1); !m || sec {
		t.Errorf("track 1: main %v, second %v; want main only", m, sec)
	}
	if m, _ := role(2); m {
		t.Error("the second track also reads as the main one")
	}

	// The main track can't be the second line too.
	if err := s.SetSecondarySubtitleTrack(1); !errors.Is(err, ErrInvalid) {
		t.Errorf("the main track as the second: got %v, want ErrInvalid", err)
	}
	// Nor can a track that isn't a subtitle, or isn't there.
	for _, id := range []int{-1, 99} {
		if err := s.SetSecondarySubtitleTrack(id); !errors.Is(err, ErrInvalid) {
			t.Errorf("track %d: got %v, want ErrInvalid", id, err)
		}
	}

	// Making the second track the main one gives the second line up.
	if err := s.SetSubtitleTrack(2); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "swapped", func(*recorder) bool { m, sec := role(2); return m && !sec })

	// Off.
	if err := s.SetSecondarySubtitleTrack(3); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "second line on track 3", func(*recorder) bool { _, sec := role(3); return sec })
	if err := s.SetSecondarySubtitleTrack(0); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "second line off", func(*recorder) bool { _, sec := role(3); return !sec })
}

// An addon's file added as the second line leaves the main subtitles alone.
func TestAddSecondarySubtitle(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	srv, _ := subtitleServer(t)
	path, _ := filepath.Abs("testdata/tracks.mkv")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Captions: "on", SubtitleLanguage: "en"}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { st := s.Snapshot(); return !st.Loading && len(st.Tracks) > 0 })
	if err := s.SetPaused(true); err != nil {
		t.Fatal(err)
	}
	if err := s.SetSubtitleTrack(1); err != nil {
		t.Fatal(err)
	}
	id, err := s.AddSubtitle(t.Context(), Subtitle{URL: srv.URL + "/fr.srt", Lang: "fr", Title: "Test addon", Secondary: true})
	if err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the added track as the second line", func(*recorder) bool {
		var main, second bool
		for _, tr := range s.Snapshot().Tracks {
			if tr.ID == id {
				second = tr.Secondary
			}
			if tr.ID == 1 && tr.Type == "sub" {
				main = tr.Selected
			}
		}
		return main && second
	})
}
