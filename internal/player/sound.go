//go:build !ios

package player

import (
	"fmt"
	"log/slog"
	"math"
	"strings"

	"github.com/k22i/Peli/internal/store"
)

// The sound is one lavfi chain in mpv's af, from filters in our LGPL build
// (build/libmpv/build.sh): dialoguenhance lifts the centre (speech) of a
// stereo mix (lavfi downmixes surround to stereo first, so a 5.1 track
// comes out of the front); the equalizer presets are af_biquads'; night
// mode is dynaudnorm, which evens loud and quiet within half a second.
// loudnorm was the other candidate: about 25 times the CPU (60 s of 5.1 in
// 5.3 s against 0.2–0.4 s) and a 3 s lookahead, which delays sound after
// every seek.

const (
	dialogueFilter = "dialoguenhance=original=1:enhance=2:voice=2"
	nightFilter    = "dynaudnorm=f=150:g=7:p=0.9:m=10"
)

// eqFilters are each preset's filters; the boosting ones start with a cut,
// so their peaks have room (there's no limiter in the build).
var eqFilters = map[string][]string{
	"flat":   nil,
	"bass":   {"volume=-5dB", "bass=g=6:f=100:w=0.6"},
	"treble": {"volume=-4dB", "treble=g=5:f=6000:w=0.6"},
	// Speech forward: less rumble, more presence.
	"voice":    {"volume=-3dB", "bass=g=-4:f=150:w=0.6", "equalizer=f=2500:t=q:w=1:g=4", "equalizer=f=5000:t=q:w=1.2:g=2"},
	"loudness": {"volume=-4dB", "bass=g=5:f=90:w=0.6", "treble=g=3:f=8000:w=0.6"},
}

// soundChain is mpv's af for s: "" for the track as it is.
func soundChain(s store.Sound) string {
	var chain []string
	if s.DialogueBoost {
		chain = append(chain, dialogueFilter)
	}
	chain = append(chain, eqFilters[s.Equalizer]...)
	if s.NightMode {
		chain = append(chain, nightFilter)
	}
	if len(chain) == 0 {
		return ""
	}
	return "@peli-sound:lavfi=[" + strings.Join(chain, ",") + "]"
}

// audioProps are the mpv properties for this device's output.
func audioProps(a store.Audio) [][2]string {
	channels, max := "auto-safe", "100"
	if a.StereoDownmix {
		channels = "stereo"
	}
	if a.VolumeBoost {
		max = "150"
	}
	device := a.Device
	if device == "" {
		device = "auto"
	}
	return [][2]string{{"audio-channels", channels}, {"volume-max", max}, {"audio-device", device}}
}

// soundFor is the sound a file plays with: the one opts names, else the
// title's own, else its profile's.
func (s *Service) soundFor(opts LoadOptions) store.Sound {
	if opts.Sound != nil {
		return *opts.Sound
	}
	title, profile := s.adjustmentsFor(opts)
	if title != nil && title.Sound != nil && title.Sound.Valid() {
		return *title.Sound
	}
	if profile != nil && profile.Sound.Valid() {
		return profile.Sound
	}
	return store.DefaultSound()
}

// audioFor is this device's output.
func (s *Service) audioFor() store.Audio {
	s.mu.Lock()
	settings := s.settings
	s.mu.Unlock()
	if settings != nil {
		if d, err := settings.DeviceSettings(); err == nil && d.Audio.Valid() {
			return d.Audio
		}
	}
	return store.DefaultAudio()
}

// applySound sets the sound and the output on the session. A filter the
// build lacks leaves the sound as it is, rather than silent.
func (s *Service) applySound(ses *session, sound store.Sound, audio store.Audio) {
	for _, p := range audioProps(audio) {
		if err := ses.m.setProperty(p[0], p[1]); err != nil {
			slog.Warn("player: audio output not set", "property", p[0], "error", err)
		}
	}
	if err := ses.m.setProperty("af", soundChain(sound)); err != nil {
		slog.Warn("player: sound not set", "error", err)
		_ = ses.m.setProperty("af", "")
	}
}

// SetSound changes how the file sounds from now on: the sheet's Sound tab
// and the B key call it.
func (s *Service) SetSound(sound store.Sound) error {
	if !sound.Valid() {
		return ErrInvalid
	}
	if s.current() == nil {
		return ErrNotPlaying
	}
	return s.set("af", soundChain(sound))
}

// SetAudio changes this device's output from now on (the setting is saved
// by the caller).
func (s *Service) SetAudio(audio store.Audio) error {
	if !audio.Valid() {
		return ErrInvalid
	}
	if s.current() == nil {
		return ErrNotPlaying
	}
	for _, p := range audioProps(audio) {
		if err := s.set(p[0], p[1]); err != nil {
			return err
		}
	}
	return nil
}

// MaxAudioDelay bounds SetAudioDelay, in seconds either way.
const MaxAudioDelay = 10

// SetAudioDelay moves the sound later (positive) or earlier than the
// picture, for this session: a track out of sync is the file's, not a
// setting.
func (s *Service) SetAudioDelay(delay float64) error {
	if math.IsNaN(delay) || math.Abs(delay) > MaxAudioDelay {
		return ErrInvalid
	}
	return s.set("audio-delay", fmt.Sprintf("%.3f", delay))
}

func audioDevices(v any) []AudioDevice {
	list, _ := v.([]any)
	out := []AudioDevice{}
	for _, item := range list {
		m, _ := item.(map[string]any)
		name, _ := m["name"].(string)
		desc, _ := m["description"].(string)
		if name != "" {
			out = append(out, AudioDevice{Name: name, Description: desc})
		}
	}
	return out
}

// AudioDevices lists the outputs: the session's, or a short-lived mpv's
// when nothing plays (Settings asks before any video).
func (s *Service) AudioDevices() ([]AudioDevice, error) {
	if ses := s.current(); ses != nil {
		v, err := ses.m.getNode("audio-device-list")
		if err != nil {
			return nil, notPlaying(err)
		}
		return audioDevices(v), nil
	}
	m, err := mpvCreate()
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	defer m.destroy()
	for _, o := range [][2]string{{"vo", "null"}, {"idle", "yes"}, {"config", "no"}} {
		_ = m.setOptionString(o[0], o[1])
	}
	if err := m.initialize(); err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	v, err := m.getNode("audio-device-list")
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	return audioDevices(v), nil
}
