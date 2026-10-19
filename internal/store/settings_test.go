package store

import (
	"errors"
	"testing"

	bolt "go.etcd.io/bbolt"
)

var japanese = ProfileSettings{AudioLanguage: "jpn", SubtitleLanguage: "en", SubtitleSize: "large", Captions: "on"}

// The acceptance criterion: settings persist, per profile where they follow a
// person and per device where they follow the machine.
func TestSettingsPersistPerProfile(t *testing.T) {
	s, path := openTemp(t)
	anna := must[Profile](t)(s.CreateProfile(Profile{Name: "Anna"}))
	ben := must[Profile](t)(s.CreateProfile(Profile{Name: "Ben"}))

	equal(t, must[ProfileSettings](t)(s.ProfileSettings(anna.ID)), DefaultProfileSettings())
	equal(t, must[DeviceSettings](t)(s.DeviceSettings()), DeviceSettings{HardwareDecoding: true, Diagnostics: false})

	check(t, s.SaveProfileSettings(anna.ID, japanese))
	check(t, s.SaveDeviceSettings(DeviceSettings{HardwareDecoding: false, Diagnostics: true}))
	check(t, s.Close())

	s, err := Open(path)
	check(t, err)
	defer s.Close()
	equal(t, must[ProfileSettings](t)(s.ProfileSettings(anna.ID)), japanese)
	equal(t, must[ProfileSettings](t)(s.ProfileSettings(ben.ID)), DefaultProfileSettings())
	equal(t, must[DeviceSettings](t)(s.DeviceSettings()), DeviceSettings{HardwareDecoding: false, Diagnostics: true})

	check(t, s.DeleteProfile(anna.ID))
	if _, err := s.ProfileSettings(anna.ID); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("deleted profile's settings err = %v", err)
	}
}

func TestProfileSettingsValidation(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))

	for name, settings := range map[string]ProfileSettings{
		"language name":    {AudioLanguage: "English", SubtitleSize: "medium", Captions: "system"},
		"upper case":       {SubtitleLanguage: "EN", SubtitleSize: "medium", Captions: "system"},
		"no size":          {Captions: "system"},
		"unknown size":     {SubtitleSize: "huge", Captions: "system"},
		"unknown captions": {SubtitleSize: "medium", Captions: "sometimes"},
	} {
		if err := s.SaveProfileSettings(p.ID, settings); !errors.Is(err, ErrInvalidSettings) {
			t.Errorf("%s: err = %v, want ErrInvalidSettings", name, err)
		}
	}
	if err := s.SaveProfileSettings(99, DefaultProfileSettings()); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("unknown profile err = %v", err)
	}
}

// Fields added after a record was saved keep their defaults.
func TestSettingsDecodeOverDefaults(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	check(t, s.update(p.ID, func(b *bolt.Bucket) error {
		return b.Put(keySettings, []byte(`{"audioLanguage":"fr"}`))
	}))
	want := DefaultProfileSettings()
	want.AudioLanguage = "fr"
	equal(t, must[ProfileSettings](t)(s.ProfileSettings(p.ID)), want)
}

func TestCurrentProfile(t *testing.T) {
	s, path := openTemp(t)

	// First launch: a local Guest profile.
	guest := must[Profile](t)(s.CurrentProfile())
	if guest.Name != "Guest" || guest.NuvioIndex != nil || guest.ID == 0 {
		t.Fatalf("first current profile = %+v", guest)
	}
	must[Profile](t)(s.CreateProfile(Profile{Name: "Later"}))
	check(t, s.Close())

	// Later launches reuse it rather than adding another.
	s, err := Open(path)
	check(t, err)
	defer s.Close()
	equal(t, must[Profile](t)(s.CurrentProfile()), guest)
	if profiles := must[[]Profile](t)(s.Profiles()); len(profiles) != 2 {
		t.Fatalf("profiles = %+v", profiles)
	}
}
