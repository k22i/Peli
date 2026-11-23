package playback

import (
	"encoding/json"
	"errors"
	"testing"
)

func TestLoadOptionsValid(t *testing.T) {
	style := SubtitleStyle{Font: "sans", Size: 100, Color: "#FFFFFF", Edge: "outline"}
	for name, tc := range map[string]struct {
		opts LoadOptions
		want bool
	}{
		"zero":               {LoadOptions{}, true},
		"start":              {LoadOptions{Start: 90}, true},
		"negative start":     {LoadOptions{Start: -1}, false},
		"languages":          {LoadOptions{AudioLanguages: []string{"jpn", "en"}, SubtitleLanguage: "en"}, true},
		"empty audio entry":  {LoadOptions{AudioLanguages: []string{"en", ""}}, false},
		"list in a language": {LoadOptions{SubtitleLanguage: "en,fr"}, false},
		"captions":           {LoadOptions{Captions: "system"}, true},
		"unknown captions":   {LoadOptions{Captions: "loud"}, false},
		"size":               {LoadOptions{SubtitleSize: "large"}, true},
		"unknown size":       {LoadOptions{SubtitleSize: "huge"}, false},
		"style":              {LoadOptions{SubtitleStyle: &style}, true},
		"watching w/o id":    {LoadOptions{Watching: &Watching{ContentType: "movie"}}, false},
		"watching with id":   {LoadOptions{Watching: &Watching{ContentID: "tt1", ContentType: "movie"}}, true},
	} {
		if got := tc.opts.Valid(); got != tc.want {
			t.Errorf("%s: Valid = %v, want %v", name, got, tc.want)
		}
	}
	bad := style
	bad.Color = "red"
	if bad.Valid() {
		t.Error("a colour that isn't #RRGGBB should not be valid")
	}
}

func TestMarshalErrorCodes(t *testing.T) {
	for err, code := range map[error]string{
		ErrInvalid:      CodeInvalid,
		ErrNotPlaying:   CodeNotPlaying,
		ErrSubtitles:    CodeSubtitles,
		ErrUnavailable:  CodeUnavailable,
		errors.New("x"): CodeUnavailable,
	} {
		var got struct{ Code string }
		if json.Unmarshal(MarshalError(err), &got); got.Code != code {
			t.Errorf("%v: code %q, want %q", err, got.Code, code)
		}
	}
}

func TestSecondaryIs(t *testing.T) {
	st := State{Tracks: []Track{{ID: 1, Type: "sub"}, {ID: 2, Type: "sub", Secondary: true}, {ID: 3, Type: "audio", Secondary: true}}}
	if !st.SecondaryIs(2) || st.SecondaryIs(1) || st.SecondaryIs(3) || st.SecondaryIs(9) {
		t.Error("SecondaryIs: only subtitle track 2 is the second line")
	}
}

// Hidden, no track reports as the main subtitle track, so the frontend reads
// the subtitles as off; the second line and the input are left alone.
func TestHideMainSubtitle(t *testing.T) {
	tracks := []Track{
		{ID: 1, Type: "audio", Selected: true},
		{ID: 1, Type: "sub", Selected: true},
		{ID: 2, Type: "sub", Secondary: true},
		{ID: 3, Type: "sub"},
	}
	got := HideMainSubtitle(tracks)
	if !got[0].Selected || got[1].Selected || got[2].Selected || got[3].Selected {
		t.Errorf("hidden: want only the audio track selected (%+v)", got)
	}
	if !got[2].Secondary {
		t.Errorf("hidden: the second line stays the second line (%+v)", got)
	}
	if !tracks[1].Selected {
		t.Error("HideMainSubtitle changed the tracks it was given")
	}
}

// A new file shows its subtitles: off is a hidden track, not a deselect, which
// mpv 0.41 refresh-seeks on.
func TestTrackPropsStartShown(t *testing.T) {
	style := SubtitleStyle{Font: "sans", Size: 100, Color: "#FFFFFF", Edge: "outline"}
	for name, o := range map[string]LoadOptions{
		"plain":     {},
		"captions":  {Captions: "on", SubtitleLanguage: "en"},
		"styled":    {SubtitleStyle: &style},
		"sub-scale": {SubtitleSize: "large"},
	} {
		props := TrackProps(o, false, IOSFonts)
		if last := props[len(props)-1]; last[0] != "sub-visibility" || last[1] != "yes" {
			t.Errorf("%s: last property %v, want sub-visibility yes", name, last)
		}
		// Appended, not inserted: the captions pick these by index.
		if props[4][0] != "subs-fallback" {
			t.Errorf("%s: the track properties moved (%v)", name, props)
		}
	}
}
