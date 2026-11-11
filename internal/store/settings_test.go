package store

import (
	"errors"
	"testing"

	bolt "go.etcd.io/bbolt"
)

var japanese = ProfileSettings{
	AudioLanguages: []string{"jpn"}, SubtitleLanguage: "en", SecondSubtitleLanguage: "ja", SubtitleSize: "large", Captions: "on",
	SubtitleStyle:  SubtitleStyle{Font: "sans", Size: 135, Color: "#FFFFFF", Edge: "outline", Backdrop: 60},
	Picture:        Picture{Preset: "cinema", Brightness: -4, Contrast: 6, Saturation: -6, Gamma: -4},
	PicturePresets: []NamedPicture{}, Framing: Framing{Fit: "fill", Aspect: "auto", AutoCrop: true},
	Sound: Sound{DialogueBoost: true, NightMode: true, Equalizer: "voice"},
}

var laptop = DeviceSettings{
	HardwareDecoding: false, Diagnostics: true, TorrentStreaming: true, TorrentCacheGB: 20,
	MaxResolution: "1080p", HDR: "off", DolbyVision: "on",
	Quality: Quality{Scaling: "high", Deband: "low", Sharpen: 3, Upscaler: "fsr", MotionSmoothing: true,
		Deinterlace: "on", ToneMapping: "bt.2390", TargetPeak: 250},
	Audio: Audio{Device: "coreaudio/BuiltInSpeakerDevice", StereoDownmix: true, VolumeBoost: true},
}

// The acceptance criterion: settings persist, per profile where they follow a
// person and per device where they follow the machine.
func TestSettingsPersistPerProfile(t *testing.T) {
	s, path := openTemp(t)
	anna := must[Profile](t)(s.CreateProfile(Profile{Name: "Anna"}))
	ben := must[Profile](t)(s.CreateProfile(Profile{Name: "Ben"}))

	equal(t, must[ProfileSettings](t)(s.ProfileSettings(anna.ID)), DefaultProfileSettings())
	equal(t, must[DeviceSettings](t)(s.DeviceSettings()), DefaultDeviceSettings())
	equal(t, DefaultDeviceSettings(), DeviceSettings{
		HardwareDecoding: true, SkipTimesOnline: true, TorrentCacheGB: 5,
		MaxResolution: "auto", HDR: "auto", DolbyVision: "auto", Quality: DefaultQuality(),
		Audio: DefaultAudio(),
	})

	check(t, s.SaveProfileSettings(anna.ID, japanese))
	check(t, s.SaveDeviceSettings(laptop))
	check(t, s.Close())

	s, err := Open(path)
	check(t, err)
	defer s.Close()
	equal(t, must[ProfileSettings](t)(s.ProfileSettings(anna.ID)), japanese)
	equal(t, must[ProfileSettings](t)(s.ProfileSettings(ben.ID)), DefaultProfileSettings())
	equal(t, must[DeviceSettings](t)(s.DeviceSettings()), laptop)

	check(t, s.DeleteProfile(anna.ID))
	if _, err := s.ProfileSettings(anna.ID); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("deleted profile's settings err = %v", err)
	}
}

// The torrent cache is one of the sizes Settings offers (#55).
func TestDeviceSettingsValidation(t *testing.T) {
	s, _ := openTemp(t)
	for _, gb := range []int{0, -5, 3, 1000} {
		device := DefaultDeviceSettings()
		device.TorrentCacheGB = gb
		if err := s.SaveDeviceSettings(device); !errors.Is(err, ErrInvalidSettings) {
			t.Errorf("cache of %d GB: err = %v", gb, err)
		}
	}
	// The stream preferences (#98) are one of the choices Settings offers.
	for name, change := range map[string]func(*DeviceSettings){
		"cap of 4320p":     func(d *DeviceSettings) { d.MaxResolution = "4320p" },
		"no cap":           func(d *DeviceSettings) { d.MaxResolution = "" },
		"HDR maybe":        func(d *DeviceSettings) { d.HDR = "maybe" },
		"Dolby Vision off": func(d *DeviceSettings) { d.DolbyVision = "Off" },
		"HDR unset":        func(d *DeviceSettings) { d.HDR = "" },
	} {
		device := DefaultDeviceSettings()
		change(&device)
		if err := s.SaveDeviceSettings(device); !errors.Is(err, ErrInvalidSettings) {
			t.Errorf("%s: err = %v", name, err)
		}
	}
	equal(t, must[DeviceSettings](t)(s.DeviceSettings()), DefaultDeviceSettings())
}

func TestProfileSettingsValidation(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))

	for name, settings := range map[string]ProfileSettings{
		"language name":    {AudioLanguages: []string{"English"}, SubtitleSize: "medium", Captions: "system"},
		"empty language":   {AudioLanguages: []string{"en", ""}, SubtitleSize: "medium", Captions: "system"},
		"language twice":   {AudioLanguages: []string{"en", "ja", "en"}, SubtitleSize: "medium", Captions: "system"},
		"too many":         {AudioLanguages: []string{"en", "es", "fr", "de", "it", "pt", "nl", "sv", "pl"}, SubtitleSize: "medium", Captions: "system"},
		"upper case":       {SubtitleLanguage: "EN", SubtitleSize: "medium", Captions: "system"},
		"second language":  {SecondSubtitleLanguage: "Japanese", SubtitleSize: "medium", Captions: "system"},
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
	want.AudioLanguages = []string{"fr"}
	equal(t, must[ProfileSettings](t)(s.ProfileSettings(p.ID)), want)
}

// The audio languages are a list (#98): the order is kept, and a record saved
// with one language, or none, reads as a list.
func TestAudioLanguagesKeepTheirOrder(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))

	settings := DefaultProfileSettings()
	settings.AudioLanguages = []string{"ja", "en", "ko"}
	check(t, s.SaveProfileSettings(p.ID, settings))
	equal(t, must[ProfileSettings](t)(s.ProfileSettings(p.ID)).AudioLanguages, []string{"ja", "en", "ko"})

	// A nil list is none, and reads as an empty one: it is JSON for the
	// frontend, which can't map null.
	settings.AudioLanguages = nil
	check(t, s.SaveProfileSettings(p.ID, settings))
	equal(t, must[ProfileSettings](t)(s.ProfileSettings(p.ID)).AudioLanguages, []string{})

	// A profile that saved "audioLanguage" before the list keeps it, but a
	// list it saved since wins.
	for record, want := range map[string][]string{
		`{"audioLanguage":"ja"}`:                         {"ja"},
		`{"audioLanguage":""}`:                           {},
		`{"audioLanguage":"ja","audioLanguages":["en"]}`: {"en"},
		`{"audioLanguages":null}`:                        {},
	} {
		check(t, s.update(p.ID, func(b *bolt.Bucket) error { return b.Put(keySettings, []byte(record)) }))
		equal(t, must[ProfileSettings](t)(s.ProfileSettings(p.ID)).AudioLanguages, want)
	}
}

func TestCurrentProfile(t *testing.T) {
	s, path := openTemp(t)

	// First launch: a local Guest profile.
	guest := must[Profile](t)(s.CurrentProfile())
	if guest.Name != "Guest" || !guest.Guest || guest.NuvioIndex != nil || guest.ID == 0 {
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

func TestSwitchToGuest(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[[]Profile](t)(s.LinkNuvioProfiles("me", []Profile{{Name: "Kevin", NuvioIndex: ptr(1)}}))

	// No Guest yet: switching makes one and makes it current.
	guest := must[Profile](t)(s.SwitchToGuest())
	if !guest.Guest || guest.Name != "Guest" || guest.ID == linked[0].ID {
		t.Fatalf("guest = %+v", guest)
	}
	equal(t, must[Profile](t)(s.CurrentProfile()), guest)

	// Switching again reuses it.
	check(t, s.SetCurrentProfile(linked[0].ID))
	equal(t, must[Profile](t)(s.SwitchToGuest()), guest)
	equal(t, must[Profile](t)(s.CurrentProfile()), guest)
	if profiles := must[[]Profile](t)(s.Profiles()); len(profiles) != 2 {
		t.Fatalf("profiles = %+v", profiles)
	}
}

func TestOneGuest(t *testing.T) {
	s, _ := openTemp(t)
	guest := must[Profile](t)(s.CurrentProfile())

	if _, err := s.CreateProfile(Profile{Name: "Another guest", Guest: true}); !errors.Is(err, ErrGuestExists) {
		t.Fatalf("creating a second Guest = %v, want ErrGuestExists", err)
	}
	other := must[Profile](t)(s.CreateProfile(Profile{Name: "Other"}))
	other.Guest = true
	if err := s.UpdateProfile(other); !errors.Is(err, ErrGuestExists) {
		t.Fatalf("making a second Guest = %v, want ErrGuestExists", err)
	}
	guest.Name = "Visitor"
	check(t, s.UpdateProfile(guest))

	guest.NuvioIndex = ptr(1)
	if err := s.UpdateProfile(guest); !errors.Is(err, ErrInvalidProfile) {
		t.Fatalf("linking the Guest = %v, want ErrInvalidProfile", err)
	}
	if _, err := s.LinkNuvioProfiles("me", []Profile{{Name: "Kevin", NuvioIndex: ptr(1), Guest: true}}); !errors.Is(err, ErrInvalidProfile) {
		t.Fatalf("linking a Guest = %v, want ErrInvalidProfile", err)
	}
}

// The Guest's writes are never queued for Nuvio: there is nothing to push.
func TestGuestQueuesNoPushes(t *testing.T) {
	s, _ := openTemp(t)
	guest := must[Profile](t)(s.CurrentProfile())
	check(t, s.SaveLibraryItem(guest.ID, dune))
	must[Progress](t)(s.SaveProgress(guest.ID, episode))
	check(t, s.MarkWatched(guest.ID, WatchedItem{ContentID: "tt1160419", ContentType: "movie", WatchedAt: 4000}))
	check(t, s.SetAddons(guest.ID, []Addon{cinemeta}))
	check(t, s.RemoveLibraryItem(guest.ID, dune.ContentID, dune.ContentType))
	if pending := must[[]Push](t)(s.Pending(guest.ID)); len(pending) != 0 {
		t.Fatalf("pending = %+v", pending)
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

func TestDeleteProfileKeepsCurrent(t *testing.T) {
	s, _ := openTemp(t)
	guest := must[Profile](t)(s.CurrentProfile())
	kevin := must[Profile](t)(s.CreateProfile(Profile{Name: "Kevin", NuvioIndex: ptr(1)}))
	kids := must[Profile](t)(s.CreateProfile(Profile{Name: "Kids", NuvioIndex: ptr(3)}))
	check(t, s.SetCurrentProfile(kids.ID))

	// Removing the Guest from the picker leaves the current profile as it is.
	check(t, s.DeleteProfile(guest.ID))
	equal(t, must[Profile](t)(s.CurrentProfile()), kids)

	// Removing the current one forgets it, so a profile with its ID can't
	// become current by accident.
	check(t, s.DeleteProfile(kids.ID))
	equal(t, must[Profile](t)(s.CurrentProfile()), kevin)
	if err := s.DeleteProfile(kids.ID); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("deleting it again = %v, want ErrProfileNotFound", err)
	}
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

func TestServerPersists(t *testing.T) {
	s, path := openTemp(t)
	equal(t, must[string](t)(s.Server()), "")

	check(t, s.SetServer("https://nuvio.example.com"))
	check(t, s.Close())
	s, err := Open(path)
	check(t, err)
	defer s.Close()
	equal(t, must[string](t)(s.Server()), "https://nuvio.example.com")

	check(t, s.SetServer(""))
	equal(t, must[string](t)(s.Server()), "")
}

// The device ID is made once and kept, so a watch party knows this install
// again after a restart (ADR-0051).
func TestDeviceIDPersists(t *testing.T) {
	s, path := openTemp(t)
	id := must[string](t)(s.DeviceID())
	if len(id) != len("sinag-")+32 || id[:6] != "sinag-" {
		t.Fatalf("id = %q", id)
	}
	equal(t, must[string](t)(s.DeviceID()), id)
	check(t, s.Close())
	s, err := Open(path)
	check(t, err)
	defer s.Close()
	equal(t, must[string](t)(s.DeviceID()), id)
}

func TestQualityIsValidated(t *testing.T) {
	if !DefaultQuality().Valid() || !laptop.Quality.Valid() {
		t.Fatal("the default or laptop's quality isn't valid")
	}
	for _, q := range []Quality{
		{Scaling: "ultra", Deband: "off", Upscaler: "off", Deinterlace: "auto", ToneMapping: "auto"},
		{Scaling: "fast", Deband: "max", Upscaler: "off", Deinterlace: "auto", ToneMapping: "auto"},
		{Scaling: "fast", Deband: "off", Sharpen: 11, Upscaler: "off", Deinterlace: "auto", ToneMapping: "auto"},
		{Scaling: "fast", Deband: "off", Upscaler: "nnedi3", Deinterlace: "auto", ToneMapping: "auto"},
		{Scaling: "fast", Deband: "off", Upscaler: "off", Deinterlace: "maybe", ToneMapping: "auto"},
		{Scaling: "fast", Deband: "off", Upscaler: "off", Deinterlace: "auto", ToneMapping: "reinhard"},
		{Scaling: "fast", Deband: "off", Upscaler: "off", Deinterlace: "auto", ToneMapping: "auto", TargetPeak: 50},
	} {
		if q.Valid() {
			t.Errorf("%+v: valid", q)
		}
	}
}

// A caller from before picture, framing and quality saves the defaults.
func TestEmptySectionsSaveAsDefaults(t *testing.T) {
	s, _ := openTemp(t)
	anna := must[Profile](t)(s.CreateProfile(Profile{Name: "Anna"}))
	old := japanese
	old.Picture, old.Framing = Picture{}, Framing{}
	check(t, s.SaveProfileSettings(anna.ID, old))
	got := must[ProfileSettings](t)(s.ProfileSettings(anna.ID))
	equal(t, got.Picture, DefaultPicture())
	equal(t, got.Framing, DefaultFraming())
	device := laptop
	device.Quality = Quality{}
	check(t, s.SaveDeviceSettings(device))
	equal(t, must[DeviceSettings](t)(s.DeviceSettings()).Quality, DefaultQuality())
}
