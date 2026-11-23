//go:build !ios

package player

import (
	"slices"
	"testing"

	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/store"
)

func TestFramingProps(t *testing.T) {
	props := func(f store.Framing) map[string]string {
		m := map[string]string{}
		for _, p := range framingProps(f) {
			m[p[0]] = p[1]
		}
		return m
	}
	fit := props(store.DefaultFraming())
	if fit["keepaspect"] != "yes" || fit["panscan"] != "0" || fit["video-unscaled"] != "no" ||
		fit["video-aspect-override"] != "-1" || fit["vf"] != "" || fit["video-rotate"] != "0" {
		t.Errorf("fit: %v", fit)
	}
	if got := props(store.Framing{Fit: "fill", Aspect: "auto"})["panscan"]; got != "1" {
		t.Errorf("fill: panscan %s, want 1", got)
	}
	if got := props(store.Framing{Fit: "stretch", Aspect: "auto"})["keepaspect"]; got != "no" {
		t.Errorf("stretch: keepaspect %s, want no", got)
	}
	if got := props(store.Framing{Fit: "original", Aspect: "auto"})["video-unscaled"]; got != "downscale-big" {
		t.Errorf("original: video-unscaled %s", got)
	}
	both := props(store.Framing{Fit: "fit", Aspect: "2.39:1", Zoom: 0.5, PanX: -0.25, Rotate: 90, FlipH: true, FlipV: true})
	if both["video-aspect-override"] != "2.39:1" || both["video-zoom"] != "0.5000" || both["video-pan-x"] != "-0.2500" ||
		both["video-rotate"] != "90" || both["vf"] != "@peli-hflip:lavfi=[hflip],@peli-vflip:lavfi=[vflip]" {
		t.Errorf("aspect, zoom, pan, rotate, flips: %v", both)
	}
	// The props are playback's, but the order they're set in is the
	// desktop's: panscan beside the fit it comes from, the filter last.
	var order []string
	for _, p := range framingProps(store.Framing{Fit: "fill"}) {
		order = append(order, p[0])
	}
	want := []string{"keepaspect", "panscan", "video-unscaled", "video-aspect-override",
		"video-zoom", "video-pan-x", "video-pan-y", "video-rotate", "vf"}
	if !slices.Equal(order, want) {
		t.Errorf("order = %v, want %v", order, want)
	}
}

func TestCropProp(t *testing.T) {
	for _, c := range []struct {
		crop store.Crop
		want string
	}{
		{store.Crop{}, ""},
		// A 2.39:1 film in a 1920×1080 frame: bars of 12.8 % top and bottom.
		{store.Crop{Top: 12.8, Bottom: 12.8}, "1920x804+0+138"},
		{store.Crop{Left: 10, Right: 5}, "1632x1080+192+0"},
		// The most it cuts: the middle fifth is left.
		{store.Crop{Top: 40, Bottom: 40, Left: 40, Right: 40}, "384x216+768+432"},
	} {
		if got := playback.CropProp(c.crop, 1920, 1080); got != c.want {
			t.Errorf("CropProp(%+v) = %q, want %q", c.crop, got, c.want)
		}
	}
	if got := playback.CropProp(store.Crop{Top: 10}, 0, 0); got != "" {
		t.Errorf("unknown size: %q, want none", got)
	}
}

// The bars themselves and how frames agree are playback's tests
// (internal/playback/autocrop_test.go); what a title and a profile frame
// with is the desktop's.

func TestFramingForPrefersTheTitleThenTheProfilesFit(t *testing.T) {
	s := NewService("test")
	ultrawide := store.Framing{Fit: "fit", Aspect: "auto", Crop: store.Crop{Top: 12, Bottom: 12}}
	UseSettings(s, framingStore{
		profile: store.Framing{Fit: "fill", Aspect: "4:3", Zoom: 1, AutoCrop: true},
		titles:  map[string]*store.TitleAdjustments{"tt1": {Framing: &ultrawide}},
	})
	at := func(id string) LoadOptions {
		return LoadOptions{Watching: &Watching{ProfileID: 1, ContentID: id, ContentType: "movie"}}
	}
	if got := s.framingFor(at("tt1")); got != ultrawide {
		t.Errorf("a title with its own: %+v", got)
	}
	// The profile gives its fit and auto-crop only.
	want := store.Framing{Fit: "fill", Aspect: "auto", AutoCrop: true}
	if got := s.framingFor(at("tt2")); got != want {
		t.Errorf("the profile's: %+v, want %+v", got, want)
	}
}

type framingStore struct {
	deviceSettings
	profile store.Framing
	titles  map[string]*store.TitleAdjustments
}

func (f framingStore) ProfileSettings(uint64) (store.ProfileSettings, error) {
	p := store.DefaultProfileSettings()
	p.Framing = f.profile
	return p, nil
}

func (f framingStore) TitleAdjustments(_ uint64, id string) (*store.TitleAdjustments, error) {
	return f.titles[id], nil
}
