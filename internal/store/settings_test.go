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

func TestSetCurrentProfile(t *testing.T) {
	s, path := openTemp(t)
	guest := must[Profile](t)(s.CurrentProfile())
	other := must[Profile](t)(s.CreateProfile(Profile{Name: "Other"}))

	check(t, s.SetCurrentProfile(other.ID))
	check(t, s.Close())
	s, err := Open(path)
	check(t, err)
	defer s.Close()
	equal(t, must[Profile](t)(s.CurrentProfile()), other)

	if err := s.SetCurrentProfile(99); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("SetCurrentProfile(99) = %v, want ErrProfileNotFound", err)
	}
	// Deleting the current profile falls back to the oldest.
	check(t, s.DeleteProfile(other.ID))
	equal(t, must[Profile](t)(s.CurrentProfile()), guest)
}

func TestLinkNuvioProfiles(t *testing.T) {
	s, _ := openTemp(t)
	guest := must[Profile](t)(s.CurrentProfile())

	// Signing in: Nuvio's profiles join the guest's, and the lowest index
	// becomes current whatever order they come in.
	linked := must[[]Profile](t)(s.LinkNuvioProfiles("me", []Profile{
		{Name: "Kids", NuvioIndex: ptr(3)},
		{Name: "Kevin", NuvioIndex: ptr(1)},
	}))
	if len(linked) != 2 || linked[0].Name != "Kevin" || linked[1].Name != "Kids" || linked[0].ID == 0 {
		t.Fatalf("linked = %+v", linked)
	}
	equal(t, must[Profile](t)(s.CurrentProfile()), linked[0])
	if profiles := must[[]Profile](t)(s.Profiles()); len(profiles) != 3 || profiles[0] != guest {
		t.Fatalf("profiles = %+v", profiles)
	}

	// Signing in again updates the same local profiles, keeping their data.
	check(t, s.SaveLibraryItem(linked[1].ID, dune))
	check(t, s.SetCurrentProfile(guest.ID))
	again := must[[]Profile](t)(s.LinkNuvioProfiles("me", []Profile{
		{Name: "Kevin M", NuvioIndex: ptr(1)},
		{Name: "Kids", NuvioIndex: ptr(3)},
	}))
	if again[0].ID != linked[0].ID || again[0].Name != "Kevin M" || again[1].ID != linked[1].ID {
		t.Fatalf("again = %+v, first time = %+v", again, linked)
	}
	if library := must[[]LibraryItem](t)(s.Library(linked[1].ID)); len(library) != 1 {
		t.Fatalf("library = %+v", library)
	}
	equal(t, must[Profile](t)(s.CurrentProfile()), again[0])
	if profiles := must[[]Profile](t)(s.Profiles()); len(profiles) != 3 {
		t.Fatalf("profiles = %+v", profiles)
	}

	if _, err := s.LinkNuvioProfiles("me", []Profile{{Name: "Local"}}); !errors.Is(err, ErrInvalidProfile) {
		t.Fatalf("linking a profile with no index = %v, want ErrInvalidProfile", err)
	}
	if _, err := s.LinkNuvioProfiles("me", []Profile{{Name: "Seven", NuvioIndex: ptr(7)}}); !errors.Is(err, ErrInvalidProfile) {
		t.Fatalf("linking index 7 = %v, want ErrInvalidProfile", err)
	}
}

func TestLinkAnotherAccount(t *testing.T) {
	s, _ := openTemp(t)
	guest := must[Profile](t)(s.CurrentProfile())
	mine := must[[]Profile](t)(s.LinkNuvioProfiles("me", []Profile{{Name: "Kevin", NuvioIndex: ptr(1)}}))
	check(t, s.SaveLibraryItem(mine[0].ID, dune))

	// An account that isn't known keeps what is linked.
	unknown := must[[]Profile](t)(s.LinkNuvioProfiles("", []Profile{{Name: "Kevin", NuvioIndex: ptr(1)}}))
	equal(t, unknown[0].ID, mine[0].ID)

	// Another account's profile 1 is a new profile, with none of my data.
	theirs := must[[]Profile](t)(s.LinkNuvioProfiles("them", []Profile{{Name: "Sam", NuvioIndex: ptr(1)}}))
	if theirs[0].ID == mine[0].ID {
		t.Fatalf("their profile reused mine: %+v", theirs)
	}
	if library := must[[]LibraryItem](t)(s.Library(theirs[0].ID)); len(library) != 0 {
		t.Fatalf("library = %+v", library)
	}
	equal(t, must[[]Profile](t)(s.Profiles()), []Profile{guest, theirs[0]})
}

func TestRemoveNuvioProfiles(t *testing.T) {
	s, _ := openTemp(t)
	guest := must[Profile](t)(s.CurrentProfile())
	if must[bool](t)(s.HasNuvioProfiles()) {
		t.Fatal("HasNuvioProfiles with only a guest")
	}
	linked := must[[]Profile](t)(s.LinkNuvioProfiles("me", []Profile{
		{Name: "Kevin", NuvioIndex: ptr(1)},
		{Name: "Kids", NuvioIndex: ptr(3)},
	}))
	check(t, s.SaveLibraryItem(linked[0].ID, dune))
	if !must[bool](t)(s.HasNuvioProfiles()) {
		t.Fatal("HasNuvioProfiles after linking = false")
	}

	check(t, s.RemoveNuvioProfiles())
	if profiles := must[[]Profile](t)(s.Profiles()); len(profiles) != 1 || profiles[0] != guest {
		t.Fatalf("profiles = %+v", profiles)
	}
	if must[bool](t)(s.HasNuvioProfiles()) {
		t.Fatal("HasNuvioProfiles after removing = true")
	}
	if _, err := s.Library(linked[0].ID); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("library of a removed profile: %v", err)
	}
	// The current profile was removed, so the guest's is current.
	equal(t, must[Profile](t)(s.CurrentProfile()), guest)
}

func TestRemoveNuvioProfilesLeavesNone(t *testing.T) {
	s, _ := openTemp(t)
	must[[]Profile](t)(s.LinkNuvioProfiles("me", []Profile{{Name: "Kevin", NuvioIndex: ptr(1)}}))
	check(t, s.RemoveNuvioProfiles())
	// No guest is made until something asks for the current profile, so
	// the app can tell this is a first run again.
	if profiles := must[[]Profile](t)(s.Profiles()); len(profiles) != 0 {
		t.Fatalf("profiles = %+v", profiles)
	}
}
