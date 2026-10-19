package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"slices"

	bolt "go.etcd.io/bbolt"
)

// ProfileSettings follow a person rather than a machine: the languages they
// watch in and how they like subtitles. They are local for now: whether they
// sync through Nuvio's per-platform settings blob is for the sync module (#28).
type ProfileSettings struct {
	// ISO 639 codes ("en", "jpn"), or "" for the stream's own default.
	AudioLanguage    string `json:"audioLanguage"`
	SubtitleLanguage string `json:"subtitleLanguage"`
	SubtitleSize     string `json:"subtitleSize"`
	// "system" follows the OS's captions preference; "on" and "off" override it.
	Captions string `json:"captions"`
}

// DeviceSettings belong to this machine, whoever is watching.
type DeviceSettings struct {
	HardwareDecoding bool `json:"hardwareDecoding"`
	// Opt-in crash reports and play outcomes (#90). Off unless the user turns
	// it on.
	Diagnostics bool `json:"diagnostics"`
}

var (
	SubtitleSizes      = []string{"small", "medium", "large"}
	CaptionsModes      = []string{"system", "on", "off"}
	ErrInvalidSettings = errors.New("store: invalid settings")

	languageCode = regexp.MustCompile(`^[a-z]{2,3}$`)
)

// DefaultProfileSettings are a profile's settings until it changes them.
func DefaultProfileSettings() ProfileSettings {
	return ProfileSettings{SubtitleSize: "medium", Captions: "system"}
}

// DefaultDeviceSettings are the device's settings until they are changed.
func DefaultDeviceSettings() DeviceSettings {
	return DeviceSettings{HardwareDecoding: true}
}

// ProfileSettings returns profile id's settings.
func (s *Store) ProfileSettings(id uint64) (ProfileSettings, error) {
	settings := DefaultProfileSettings()
	err := s.view(id, func(p *bolt.Bucket) error {
		return decodeOnto(p.Get(keySettings), &settings)
	})
	return settings, err
}

// SaveProfileSettings replaces profile id's settings.
func (s *Store) SaveProfileSettings(id uint64, settings ProfileSettings) error {
	if err := validateProfileSettings(settings); err != nil {
		return err
	}
	return s.update(id, func(p *bolt.Bucket) error {
		return put(p, keySettings, settings)
	})
}

// DeviceSettings returns this device's settings.
func (s *Store) DeviceSettings() (DeviceSettings, error) {
	settings := DefaultDeviceSettings()
	err := s.db.View(func(tx *bolt.Tx) error {
		return decodeOnto(tx.Bucket(bucketSettings).Get(keyDevice), &settings)
	})
	return settings, err
}

// SaveDeviceSettings replaces this device's settings.
func (s *Store) SaveDeviceSettings(settings DeviceSettings) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return put(tx.Bucket(bucketSettings), keyDevice, settings)
	})
}

// decodeOnto decodes data over v's defaults, so fields added later keep their
// default in records saved before them. Nil data leaves v as it is.
func decodeOnto(data []byte, v any) error {
	if data == nil {
		return nil
	}
	return json.Unmarshal(data, v)
}

func validateProfileSettings(settings ProfileSettings) error {
	for _, code := range []string{settings.AudioLanguage, settings.SubtitleLanguage} {
		if code != "" && !languageCode.MatchString(code) {
			return fmt.Errorf("%w: %q is not an ISO 639 language code", ErrInvalidSettings, code)
		}
	}
	if !slices.Contains(SubtitleSizes, settings.SubtitleSize) {
		return fmt.Errorf("%w: subtitle size %q", ErrInvalidSettings, settings.SubtitleSize)
	}
	if !slices.Contains(CaptionsModes, settings.Captions) {
		return fmt.Errorf("%w: captions %q", ErrInvalidSettings, settings.Captions)
	}
	return nil
}
