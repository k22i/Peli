package playback

import (
	"testing"

	"github.com/k22i/Peli/internal/store"
)

func TestFramingPanscan(t *testing.T) {
	for fit, want := range map[string]string{"fill": "1", "fit": "0", "stretch": "0", "original": "0"} {
		if got := FramingPanscan(store.Framing{Fit: fit}); got != want {
			t.Errorf("%q: %q, want %q", fit, got, want)
		}
	}
}

func TestFlipFilter(t *testing.T) {
	for name, tc := range map[string]struct {
		h, v bool
		want string
	}{
		"none":       {false, false, ""},
		"horizontal": {true, false, "@peli-hflip:lavfi=[hflip]"},
		"vertical":   {false, true, "@peli-vflip:lavfi=[vflip]"},
		"both":       {true, true, "@peli-hflip:lavfi=[hflip],@peli-vflip:lavfi=[vflip]"},
	} {
		if got := FlipFilter(store.Framing{FlipH: tc.h, FlipV: tc.v}); got != tc.want {
			t.Errorf("%s: %q, want %q", name, got, tc.want)
		}
	}
}

func TestToneProps(t *testing.T) {
	q := store.Quality{Scaling: "balanced", Deband: "off", Upscaler: "off", Deinterlace: "auto",
		ToneMapping: "hable", TargetPeak: 400}
	for name, tc := range map[string]struct {
		q      store.Quality
		hdrOut bool
		want   [][2]string
	}{
		"the set mapping and peak": {q, false, [][2]string{{"tone-mapping", "hable"}, {"target-peak", "400"}}},
		"no peak is mpv's": {store.Quality{ToneMapping: "bt.2390"},
			false, [][2]string{{"tone-mapping", "bt.2390"}, {"target-peak", "auto"}}},
		// Shown as HDR, tone mapping is mpv's both ways.
		"shown as HDR": {q, true, [][2]string{{"tone-mapping", "auto"}, {"target-peak", "auto"}}},
	} {
		got := ToneProps(tc.q, tc.hdrOut)
		if len(got) != len(tc.want) {
			t.Fatalf("%s: %v, want %v", name, got, tc.want)
		}
		for i := range tc.want {
			if got[i] != tc.want[i] {
				t.Errorf("%s: %v, want %v (in that order)", name, got, tc.want)
			}
		}
	}
}

func TestPictureOf(t *testing.T) {
	vivid := store.Picture{Preset: "vivid", Contrast: 10}
	cinema := store.Picture{Preset: "cinema", Brightness: -6}
	unknown := store.Picture{Preset: "nope"}
	for name, tc := range map[string]struct {
		named   *store.Picture
		title   *store.TitleAdjustments
		profile *store.ProfileSettings
		want    store.Picture
	}{
		"the one named wins": {&vivid, &store.TitleAdjustments{Picture: &cinema},
			&store.ProfileSettings{Picture: cinema}, vivid},
		"the title's": {nil, &store.TitleAdjustments{Picture: &cinema},
			&store.ProfileSettings{Picture: vivid}, cinema},
		"an invalid title falls through": {nil, &store.TitleAdjustments{Picture: &unknown},
			&store.ProfileSettings{Picture: vivid}, vivid},
		"a title without a picture is the profile's": {nil, &store.TitleAdjustments{},
			&store.ProfileSettings{Picture: cinema}, cinema},
		"an invalid profile is the file's": {nil, nil,
			&store.ProfileSettings{Picture: unknown}, store.DefaultPicture()},
		"no profile is the file's": {nil, nil, nil, store.DefaultPicture()},
	} {
		if got := PictureOf(tc.named, tc.title, tc.profile); got != tc.want {
			t.Errorf("%s: %+v, want %+v", name, got, tc.want)
		}
	}
}

func TestQualityOf(t *testing.T) {
	anime := store.Quality{Scaling: "high", Deband: "low", Upscaler: "anime4k", Deinterlace: "auto", ToneMapping: "auto"}
	fast := store.Quality{Scaling: "fast", Deband: "off", Upscaler: "off", Deinterlace: "off", ToneMapping: "auto"}
	unknown := store.Quality{Scaling: "max", Deband: "off", Upscaler: "off", Deinterlace: "auto", ToneMapping: "auto"}
	for name, tc := range map[string]struct {
		named  *store.Quality
		title  *store.TitleAdjustments
		device *store.DeviceSettings
		want   store.Quality
	}{
		"the one named wins": {&fast, &store.TitleAdjustments{Quality: &anime},
			&store.DeviceSettings{Quality: anime}, fast},
		"the title's": {nil, &store.TitleAdjustments{Quality: &anime},
			&store.DeviceSettings{Quality: fast}, anime},
		"an invalid title falls through": {nil, &store.TitleAdjustments{Quality: &unknown},
			&store.DeviceSettings{Quality: fast}, fast},
		"the device's": {nil, nil, &store.DeviceSettings{Quality: anime}, anime},
		"an invalid device is mpv's": {nil, nil,
			&store.DeviceSettings{Quality: unknown}, store.DefaultQuality()},
		"no device is mpv's": {nil, nil, nil, store.DefaultQuality()},
	} {
		if got := QualityOf(tc.named, tc.title, tc.device); got != tc.want {
			t.Errorf("%s: %+v, want %+v", name, got, tc.want)
		}
	}
}

func TestFramingOfAndSoundOf(t *testing.T) {
	// A profile gives its fit and auto-crop only.
	got := FramingOf(nil, nil, &store.ProfileSettings{
		Framing: store.Framing{Fit: "fill", Aspect: "4:3", Zoom: 1, AutoCrop: true},
	})
	if want := (store.Framing{Fit: "fill", Aspect: "auto", AutoCrop: true}); got != want {
		t.Errorf("the profile's framing: %+v, want %+v", got, want)
	}
	ultrawide := store.Framing{Fit: "fit", Aspect: "auto", Crop: store.Crop{Top: 12, Bottom: 12}}
	if got := FramingOf(nil, &store.TitleAdjustments{Framing: &ultrawide}, nil); got != ultrawide {
		t.Errorf("the title's framing: %+v, want %+v", got, ultrawide)
	}
	loud := store.Sound{Equalizer: "loudness", NightMode: true}
	if got := SoundOf(nil, nil, &store.ProfileSettings{Sound: loud}); got != loud {
		t.Errorf("the profile's sound: %+v, want %+v", got, loud)
	}
	if got := SoundOf(nil, nil, nil); got != store.DefaultSound() {
		t.Errorf("no profile's sound: %+v, want %+v", got, store.DefaultSound())
	}
}

func TestAudioChannelsAndAudioOf(t *testing.T) {
	if got := AudioChannels(true); got != "stereo" {
		t.Errorf("downmix: %q, want stereo", got)
	}
	if got := AudioChannels(false); got != "auto-safe" {
		t.Errorf("no downmix: %q, want auto-safe", got)
	}
	device := store.DeviceSettings{Audio: store.Audio{Device: "coreaudio/x", StereoDownmix: true}}
	if got := AudioOf(&device); got != device.Audio {
		t.Errorf("the device's output: %+v, want %+v", got, device.Audio)
	}
	// An empty device name is no device.
	if got := AudioOf(&store.DeviceSettings{}); got != store.DefaultAudio() {
		t.Errorf("no device named: %+v, want %+v", got, store.DefaultAudio())
	}
	if got := AudioOf(nil); got != store.DefaultAudio() {
		t.Errorf("no settings: %+v, want %+v", got, store.DefaultAudio())
	}
}
