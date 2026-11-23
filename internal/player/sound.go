//go:build !ios

package player

import (
	"fmt"
	"log/slog"
	"math"

	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/store"
)

// audioProps are the mpv properties for this device's output.
func audioProps(a store.Audio) [][2]string {
	max := "100"
	if a.VolumeBoost {
		max = "150"
	}
	device := a.Device
	if device == "" {
		device = "auto"
	}
	return [][2]string{{"audio-channels", playback.AudioChannels(a.StereoDownmix)}, {"volume-max", max}, {"audio-device", device}}
}

// soundFor is the sound a file plays with: the one opts names, else the
// title's own, else its profile's.
func (s *Service) soundFor(opts LoadOptions) store.Sound {
	if opts.Sound != nil {
		return *opts.Sound
	}
	title, profile := s.adjustmentsFor(opts)
	return playback.SoundOf(nil, title, profile)
}

// audioFor is this device's output.
func (s *Service) audioFor() store.Audio {
	return playback.AudioOf(s.thisDevice())
}

// applySound sets the sound and the output on the session. A filter the
// build lacks leaves the sound as it is, rather than silent.
func (s *Service) applySound(ses *session, sound store.Sound, audio store.Audio) {
	for _, p := range audioProps(audio) {
		if err := ses.m.setProperty(p[0], p[1]); err != nil {
			slog.Warn("player: audio output not set", "property", p[0], "error", err)
		}
	}
	if err := ses.m.setProperty("af", playback.SoundChain(sound)); err != nil {
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
	return s.set("af", playback.SoundChain(sound))
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
