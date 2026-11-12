//go:build !ios

package player

import (
	"testing"

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
		if got := cropProp(c.crop, 1920, 1080); got != c.want {
			t.Errorf("cropProp(%+v) = %q, want %q", c.crop, got, c.want)
		}
	}
	if got := cropProp(store.Crop{Top: 10}, 0, 0); got != "" {
		t.Errorf("unknown size: %q, want none", got)
	}
}

// letterboxed is a w×h bgr0 frame with black bars of top and bottom rows
// and left and right columns around a mid-grey picture; dark adds a black
// patch at the picture's left edge, as a dark scene has.
func letterboxed(w, h, top, bottom, left, right int, dark bool) frame {
	f := frame{w: w, h: h, stride: w * 4, data: make([]byte, w*h*4)}
	for y := range h {
		for x := range w {
			in := y >= top && y < h-bottom && x >= left && x < w-right
			if dark && x < left+w/20 {
				in = false
			}
			if in {
				i := y*f.stride + x*4
				f.data[i], f.data[i+1], f.data[i+2] = 120, 130, 140
			}
		}
	}
	return f
}

func TestDetectBars(t *testing.T) {
	got, ok := detectBars(letterboxed(400, 300, 38, 38, 0, 0, false))
	if !ok || got.Top != 12.6 || got.Bottom != 12.6 || got.Left != 0 || got.Right != 0 {
		t.Errorf("letterbox: %+v, %v; want 12.6 %% top and bottom", got, ok)
	}
	got, ok = detectBars(letterboxed(400, 300, 0, 0, 50, 50, false))
	if !ok || got.Left != 12.5 || got.Right != 12.5 || got.Top != 0 {
		t.Errorf("pillarbox: %+v, %v", got, ok)
	}
	// A line or two of black is no bar.
	if got, _ := detectBars(letterboxed(400, 300, 1, 1, 0, 0, false)); !got.Empty() {
		t.Errorf("a scan line: %+v, want none", got)
	}
	// A fade to black tells nothing.
	if _, ok := detectBars(letterboxed(400, 300, 140, 140, 0, 0, false)); ok {
		t.Error("a nearly black frame counted")
	}
	// A dark scene reads as more bar; leastBars keeps the smaller one.
	darkScene, _ := detectBars(letterboxed(400, 300, 38, 38, 0, 0, true))
	plain, _ := detectBars(letterboxed(400, 300, 38, 38, 0, 0, false))
	if darkScene.Left <= plain.Left {
		t.Fatalf("dark scene left %v, want more than %v", darkScene.Left, plain.Left)
	}
	if least := leastBars([]store.Crop{darkScene, plain, darkScene}); least != plain {
		t.Errorf("leastBars = %+v, want %+v", least, plain)
	}
}

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
