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
