package player

import (
	"errors"
	"path/filepath"
	"strconv"
	"testing"

	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
)

func TestPictureProps(t *testing.T) {
	got := pictureProps(store.Picture{Preset: "custom", Brightness: -5, Contrast: 8, Saturation: 15, Gamma: 90, Hue: 3, ShadowLift: true})
	want := [][2]string{{"brightness", "-5"}, {"contrast", "8"}, {"saturation", "15"}, {"gamma", "100"}, {"hue", "3"}}
	if len(got) != len(want) {
		t.Fatalf("pictureProps = %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Errorf("pictureProps[%d] = %v, want %v (shadow lift caps gamma at 100)", i, got[i], want[i])
		}
	}
}

// The picture is set at load, each file its own, and changes live.
func TestPictureAtLoadAndLive(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/clip.mp4")
	vivid := store.Picture{Preset: "vivid", Contrast: 10, Saturation: 20}
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Picture: &vivid}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { return !s.Snapshot().Loading })
	// mpv keeps these as floats: "20.000000".
	read := func(name string) float64 {
		t.Helper()
		ses := s.current()
		v, err := ses.m.getString(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		f, err := strconv.ParseFloat(v, 64)
		if err != nil {
			t.Fatalf("%s = %q: %v", name, v, err)
		}
		return f
	}
	if got := read("saturation"); got != 20 {
		t.Errorf("saturation at load = %v, want 20", got)
	}
	if err := s.SetPicture(store.Picture{Preset: "custom", Brightness: -12}); err != nil {
		t.Fatal(err)
	}
	if got, sat := read("brightness"), read("saturation"); got != -12 || sat != 0 {
		t.Errorf("after SetPicture: brightness %v, saturation %v; want -12 and 0", got, sat)
	}
	// The next file without a picture plays as it is.
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	if got := read("brightness"); got != 0 {
		t.Errorf("next file's brightness = %v, want 0", got)
	}
	if err := s.SetPicture(store.Picture{Preset: "standard", Gamma: 120}); !errors.Is(err, ErrInvalid) {
		t.Errorf("gamma 120: %v, want ErrInvalid", err)
	}
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Picture: &store.Picture{Preset: "nope"}}); !errors.Is(err, ErrInvalid) {
		t.Errorf("unknown preset at load: %v, want ErrInvalid", err)
	}
}

// titleStore is the store as pictureFor reads it.
type titleStore struct {
	deviceSettings
	profile store.Picture
	titles  map[string]*store.TitleAdjustments
}

func (f titleStore) ProfileSettings(uint64) (store.ProfileSettings, error) {
	p := store.DefaultProfileSettings()
	p.Picture = f.profile
	return p, nil
}

func (f titleStore) TitleAdjustments(_ uint64, contentID string) (*store.TitleAdjustments, error) {
	return f.titles[contentID], nil
}

func TestPictureForPrefersTheTitleThenTheProfile(t *testing.T) {
	s := NewService("test")
	cinema := store.Picture{Preset: "cinema", Brightness: -6}
	anime := store.Picture{Preset: "anime", Saturation: 12}
	UseSettings(s, titleStore{
		profile: cinema,
		titles:  map[string]*store.TitleAdjustments{"kitsu:1": {Picture: &anime}, "tt1": {}},
	})
	at := func(contentID string) LoadOptions {
		return LoadOptions{Watching: &Watching{ProfileID: 1, ContentID: contentID, ContentType: "series"}}
	}
	if got := s.pictureFor(at("kitsu:1")); got != anime {
		t.Errorf("a title with its own: %+v, want %+v", got, anime)
	}
	if got := s.pictureFor(at("tt1")); got != cinema {
		t.Errorf("a title without a picture section: %+v, want the profile's %+v", got, cinema)
	}
	if got := s.pictureFor(LoadOptions{}); got != store.DefaultPicture() {
		t.Errorf("no Watching: %+v, want the file as it is", got)
	}
	vivid := store.Picture{Preset: "vivid", Contrast: 10}
	opts := at("kitsu:1")
	opts.Picture = &vivid
	if got := s.pictureFor(opts); got != vivid {
		t.Errorf("named in the call: %+v, want %+v", got, vivid)
	}
}
