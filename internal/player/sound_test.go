package player

import (
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"testing"

	"github.com/k22i/Sinag/internal/store"
	"github.com/k22i/Sinag/internal/streams"
)

func TestSoundChain(t *testing.T) {
	if got := soundChain(store.DefaultSound()); got != "" {
		t.Errorf("flat: %q, want none", got)
	}
	got := soundChain(store.Sound{DialogueBoost: true, NightMode: true, Equalizer: "voice"})
	want := "@sinag-sound:lavfi=[" + dialogueFilter + ",volume=-3dB,bass=g=-4:f=150:w=0.6," +
		"equalizer=f=2500:t=q:w=1:g=4,equalizer=f=5000:t=q:w=1.2:g=2," + nightFilter + "]"
	if got != want {
		t.Errorf("all on:\n got %s\nwant %s", got, want)
	}
	for _, preset := range store.EqualizerPresets {
		if _, ok := eqFilters[preset]; !ok {
			t.Errorf("no filters for %q", preset)
		}
	}
}

func TestAudioProps(t *testing.T) {
	m := map[string]string{}
	for _, p := range audioProps(store.DefaultAudio()) {
		m[p[0]] = p[1]
	}
	if m["audio-channels"] != "auto-safe" || m["volume-max"] != "100" || m["audio-device"] != "auto" {
		t.Errorf("default: %v", m)
	}
	for _, p := range audioProps(store.Audio{Device: "coreaudio/x", StereoDownmix: true, VolumeBoost: true}) {
		m[p[0]] = p[1]
	}
	if m["audio-channels"] != "stereo" || m["volume-max"] != "150" || m["audio-device"] != "coreaudio/x" {
		t.Errorf("downmix, boost, device: %v", m)
	}
}

func TestAudioDevicesParse(t *testing.T) {
	got := audioDevices([]any{
		map[string]any{"name": "auto", "description": "Autoselect device"},
		map[string]any{"name": "coreaudio/BuiltIn", "description": "MacBook Pro Speakers"},
		map[string]any{"description": "no name"},
	})
	if len(got) != 2 || got[1] != (AudioDevice{Name: "coreaudio/BuiltIn", Description: "MacBook Pro Speakers"}) {
		t.Errorf("audioDevices = %+v", got)
	}
}

// Every sound filter is in the build mpv links, and the chain stays on.
func TestSoundAtLoadAndLive(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/clip.mp4")
	all := store.Sound{DialogueBoost: true, NightMode: true, Equalizer: "loudness"}
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Sound: &all}); err != nil {
		t.Fatal(err)
	}
	playsToTheEnd(t, s, r)
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Sound: &all}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { return !s.Snapshot().Loading })
	if af, _ := s.current().m.getString("af"); !strings.Contains(af, "dialoguenhance") {
		t.Errorf("af = %q", af)
	}
	if err := s.SetAudioDelay(0.25); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.current().m.getString("audio-delay"); !strings.HasPrefix(v, "0.25") {
		t.Errorf("audio-delay = %q", v)
	}
	if err := s.SetAudioDelay(11); !errors.Is(err, ErrInvalid) {
		t.Errorf("11 s: %v, want ErrInvalid", err)
	}
	if err := s.SetAudio(store.Audio{Device: "auto", VolumeBoost: true}); err != nil {
		t.Fatal(err)
	}
	if v, _ := s.current().m.getString("volume-max"); v != strconv.Itoa(150)+".000000" {
		t.Errorf("volume-max = %q", v)
	}
	if err := s.SetSound(store.Sound{Equalizer: "rock"}); !errors.Is(err, ErrInvalid) {
		t.Errorf("unknown preset: %v", err)
	}
	if err := s.SetSound(store.DefaultSound()); err != nil {
		t.Fatal(err)
	}
	if af, _ := s.current().m.getString("af"); af != "" {
		t.Errorf("flat af = %q, want none", af)
	}
}
