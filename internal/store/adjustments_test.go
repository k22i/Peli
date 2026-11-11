package store

import (
	"errors"
	"testing"
)

// A title's own adjustments are kept per profile and title, replaced by the
// next change, forgotten when empty, counted and cleared per profile.
func TestTitleAdjustmentsPerProfileAndTitle(t *testing.T) {
	s, path := openTemp(t)
	anna := must[Profile](t)(s.CreateProfile(Profile{Name: "Anna"}))
	ben := must[Profile](t)(s.CreateProfile(Profile{Name: "Ben"}))

	if got := must[*TitleAdjustments](t)(s.TitleAdjustments(anna.ID, "tt1160419")); got != nil {
		t.Fatalf("before any change: %+v", got)
	}
	vivid := TitleAdjustments{Picture: &Picture{Preset: "vivid", Contrast: 10, Saturation: 20}, ChangedAt: 1}
	check(t, s.SetTitleAdjustments(anna.ID, "tt1160419", &vivid))
	check(t, s.Close())

	s, err := Open(path)
	check(t, err)
	defer s.Close()
	equal(t, *must[*TitleAdjustments](t)(s.TitleAdjustments(anna.ID, "tt1160419")), vivid)
	if got := must[*TitleAdjustments](t)(s.TitleAdjustments(ben.ID, "tt1160419")); got != nil {
		t.Fatalf("another profile: %+v", got)
	}
	equal(t, must[int](t)(s.AdjustedTitles(anna.ID)), 1)
	equal(t, must[int](t)(s.AdjustedTitles(ben.ID)), 0)

	// No section left: the title follows the defaults again.
	check(t, s.SetTitleAdjustments(anna.ID, "tt1160419", &TitleAdjustments{ChangedAt: 2}))
	if got := must[*TitleAdjustments](t)(s.TitleAdjustments(anna.ID, "tt1160419")); got != nil {
		t.Fatalf("emptied: %+v", got)
	}

	check(t, s.SetTitleAdjustments(anna.ID, "tt1160419", &vivid))
	check(t, s.SetTitleAdjustments(anna.ID, "tt0903747", &vivid))
	check(t, s.ClearTitleAdjustments(anna.ID))
	equal(t, must[int](t)(s.AdjustedTitles(anna.ID)), 0)
	check(t, s.ClearTitleAdjustments(anna.ID)) // nothing left to clear
}

func TestTitleAdjustmentsRefuseBadValues(t *testing.T) {
	s, _ := openTemp(t)
	anna := must[Profile](t)(s.CreateProfile(Profile{Name: "Anna"}))
	for _, adj := range []TitleAdjustments{
		{Picture: &Picture{Preset: "standard", Brightness: 101}},
		{Picture: &Picture{Preset: "loud"}},
		{Picture: &Picture{Preset: "user:"}},
	} {
		if err := s.SetTitleAdjustments(anna.ID, "tt1160419", &adj); !errors.Is(err, ErrInvalidSettings) {
			t.Errorf("SetTitleAdjustments(%+v) = %v, want ErrInvalidSettings", *adj.Picture, err)
		}
	}
	if err := s.SetTitleAdjustments(anna.ID, "", &TitleAdjustments{}); !errors.Is(err, ErrInvalidItem) {
		t.Errorf("no content ID: %v, want ErrInvalidItem", err)
	}
}

func TestPicturePresetsAreValidated(t *testing.T) {
	s, _ := openTemp(t)
	anna := must[Profile](t)(s.CreateProfile(Profile{Name: "Anna"}))
	settings := must[ProfileSettings](t)(s.ProfileSettings(anna.ID))
	equal(t, settings.Picture, DefaultPicture())
	if settings.PicturePresets == nil {
		t.Fatal("PicturePresets is nil, want empty")
	}

	settings.Picture = Picture{Preset: "user:Night", Brightness: -10, ShadowLift: true}
	settings.PicturePresets = []NamedPicture{{Name: "Night", Picture: Picture{Preset: "custom", Brightness: -10}}}
	check(t, s.SaveProfileSettings(anna.ID, settings))
	equal(t, must[ProfileSettings](t)(s.ProfileSettings(anna.ID)).Picture, settings.Picture)

	for _, named := range [][]NamedPicture{
		{{Name: "Night"}, {Name: "Night"}},           // twice
		{{Name: " Night"}},                           // padded
		{{Name: ""}},                                 // empty
		{{Name: "Hot", Picture: Picture{Hue: -200}}}, // out of range
	} {
		bad := settings
		bad.PicturePresets = named
		for i := range bad.PicturePresets {
			if bad.PicturePresets[i].Picture.Preset == "" {
				bad.PicturePresets[i].Picture.Preset = "custom"
			}
		}
		if err := s.SaveProfileSettings(anna.ID, bad); !errors.Is(err, ErrInvalidSettings) {
			t.Errorf("presets %+v: %v, want ErrInvalidSettings", named, err)
		}
	}
}

func TestFramingIsValidated(t *testing.T) {
	for _, f := range []Framing{
		DefaultFraming(),
		{Fit: "fill", Aspect: "2.39:1", Zoom: 1.5, PanX: -1, PanY: 0.5, Rotate: 270, FlipH: true},
		{Fit: "fit", Aspect: "12:5", Crop: Crop{Top: 12.5, Bottom: 12.5}},
		{Fit: "original", Aspect: "1.33:1", AutoCrop: true},
	} {
		if !f.Valid() {
			t.Errorf("%+v: not valid", f)
		}
	}
	for _, f := range []Framing{
		{Fit: "zoom", Aspect: "auto"},
		{Fit: "fit", Aspect: "wide"},
		{Fit: "fit", Aspect: "0:9"},
		{Fit: "fit", Aspect: "auto", Zoom: 3},
		{Fit: "fit", Aspect: "auto", PanX: 1.5},
		{Fit: "fit", Aspect: "auto", Crop: Crop{Left: 41}},
		{Fit: "fit", Aspect: "auto", Crop: Crop{Left: -1}},
		{Fit: "fit", Aspect: "auto", Rotate: 45},
	} {
		if f.Valid() {
			t.Errorf("%+v: valid", f)
		}
	}
}

func TestSoundAndAudioAreValidated(t *testing.T) {
	if !DefaultSound().Valid() || (Sound{Equalizer: "rock"}).Valid() {
		t.Error("equalizer presets aren't checked")
	}
	if !DefaultAudio().Valid() || (Audio{}).Valid() {
		t.Error("an audio device must be named")
	}
	s, _ := openTemp(t)
	anna := must[Profile](t)(s.CreateProfile(Profile{Name: "Anna"}))
	if err := s.SetTitleAdjustments(anna.ID, "tt1", &TitleAdjustments{Sound: &Sound{Equalizer: "rock"}}); !errors.Is(err, ErrInvalidSettings) {
		t.Errorf("a title with an unknown preset: %v", err)
	}
}
