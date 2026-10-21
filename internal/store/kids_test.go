package store

import (
	"errors"
	"testing"
)

var (
	disney   = Addon{URL: "https://disney.example/manifest.json", Name: "Disney", Enabled: true}
	adult    = Addon{URL: "https://adult.example/manifest.json", Name: "Late night", Enabled: true}
	disabled = Addon{URL: "https://off.example/manifest.json", Name: "Off", Enabled: false}
)

func kidsProfile(t *testing.T, s *Store) Profile {
	t.Helper()
	index := 3
	kid := must[Profile](t)(s.CreateProfile(Profile{Name: "Kids", NuvioIndex: &index, PinEnabled: true}))
	check(t, s.SetKids(kid.ID, true))
	check(t, s.SetAddons(kid.ID, []Addon{disney, adult, disabled}))
	return kid
}

func TestKidsSeeOnlyAllowedAddons(t *testing.T) {
	s, _ := openTemp(t)
	kid := kidsProfile(t, s)

	// Nothing is allowed until the parent chooses.
	equal(t, must[[]Addon](t)(s.VisibleAddons(kid.ID)), []Addon{})

	check(t, s.SetKidsScope(kid.ID, KidsScope{Addons: []string{disney.URL, disabled.URL}}))
	// Only the allowed ones, and only when enabled.
	equal(t, must[[]Addon](t)(s.VisibleAddons(kid.ID)), []Addon{disney})

	// An addon installed later stays hidden until the parent allows it.
	later := Addon{URL: "https://later.example/manifest.json", Enabled: true}
	check(t, s.SetAddons(kid.ID, []Addon{disney, adult, later}))
	equal(t, must[[]Addon](t)(s.VisibleAddons(kid.ID)), []Addon{disney})
}

func TestOtherProfilesSeeEveryEnabledAddon(t *testing.T) {
	s, _ := openTemp(t)
	parent := must[Profile](t)(s.CreateProfile(Profile{Name: "Parent"}))
	check(t, s.SetAddons(parent.ID, []Addon{disney, adult, disabled}))
	// A scope left on a profile that isn't a kids profile is ignored.
	check(t, s.SetKidsScope(parent.ID, KidsScope{Addons: []string{disney.URL}}))
	equal(t, must[[]Addon](t)(s.VisibleAddons(parent.ID)), []Addon{disney, adult})
}

func TestKidsCatalogs(t *testing.T) {
	s, _ := openTemp(t)
	kid := kidsProfile(t, s)
	check(t, s.SetKidsScope(kid.ID, KidsScope{Addons: []string{disney.URL}}))
	visible := func(addon, typ, id string) bool {
		return must[bool](t)(s.CatalogVisible(kid.ID, addon, typ, id))
	}
	// An allowed addon with no narrowing shows all its catalogs.
	if !visible(disney.URL, "movie", "top") || !visible(disney.URL, "series", "new") {
		t.Fatal("an allowed addon hides its catalogs")
	}
	if visible(adult.URL, "movie", "top") {
		t.Fatal("an addon that isn't allowed shows a catalog")
	}

	check(t, s.SetKidsScope(kid.ID, KidsScope{
		Addons:   []string{disney.URL},
		Catalogs: []CatalogRef{{Addon: disney.URL, Type: "movie", ID: "top"}},
	}))
	if !visible(disney.URL, "movie", "top") {
		t.Fatal("a chosen catalog is hidden")
	}
	if visible(disney.URL, "series", "new") {
		t.Fatal("a catalog that wasn't chosen shows")
	}

	// Another profile browses everything its addons offer.
	parent := must[Profile](t)(s.CreateProfile(Profile{Name: "Parent"}))
	check(t, s.SetAddons(parent.ID, []Addon{disney, disabled}))
	if !must[bool](t)(s.CatalogVisible(parent.ID, disney.URL, "series", "new")) {
		t.Fatal("a parent profile can't browse a catalog")
	}
	if must[bool](t)(s.CatalogVisible(parent.ID, disabled.URL, "movie", "top")) {
		t.Fatal("a disabled addon shows a catalog")
	}
}

func TestSetKidsScopeValidates(t *testing.T) {
	s, _ := openTemp(t)
	kid := kidsProfile(t, s)
	for name, scope := range map[string]KidsScope{
		"empty addon":     {Addons: []string{""}},
		"duplicate addon": {Addons: []string{disney.URL, disney.URL}},
		"catalog of an addon that isn't allowed": {
			Catalogs: []CatalogRef{{Addon: adult.URL, Type: "movie", ID: "top"}},
		},
		"catalog without an id": {
			Addons:   []string{disney.URL},
			Catalogs: []CatalogRef{{Addon: disney.URL, Type: "movie"}},
		},
	} {
		if err := s.SetKidsScope(kid.ID, scope); !errors.Is(err, ErrInvalidItem) {
			t.Errorf("%s: err = %v, want ErrInvalidItem", name, err)
		}
	}
	if err := s.SetKidsScope(999, KidsScope{}); !errors.Is(err, ErrProfileNotFound) {
		t.Errorf("unknown profile: err = %v", err)
	}
}

func TestSetKidsNeedsAPinOnANuvioProfile(t *testing.T) {
	s, _ := openTemp(t)
	guest := must[Profile](t)(s.CreateProfile(Profile{Name: "Guest", Guest: true}))
	if err := s.SetKids(guest.ID, true); !errors.Is(err, ErrInvalidProfile) {
		t.Fatalf("Guest: err = %v, want ErrInvalidProfile", err)
	}
	index := 2
	noPin := must[Profile](t)(s.CreateProfile(Profile{Name: "No PIN", NuvioIndex: &index}))
	if err := s.SetKids(noPin.ID, true); !errors.Is(err, ErrInvalidProfile) {
		t.Fatalf("no PIN: err = %v, want ErrInvalidProfile", err)
	}
	// Turning it off needs nothing.
	check(t, s.SetKids(noPin.ID, false))
}

func TestKidsSurvivesProfileUpdatesAndRelinking(t *testing.T) {
	s, _ := openTemp(t)
	kid := kidsProfile(t, s)
	check(t, s.SetKidsScope(kid.ID, KidsScope{Addons: []string{disney.URL}}))

	// A profile saved from Nuvio's copy, which has no kids flag.
	renamed := kid
	renamed.Name = "Little ones"
	renamed.Kids = false
	check(t, s.UpdateProfile(renamed))
	if got := must[Profile](t)(s.Profile(kid.ID)); !got.Kids || got.Name != "Little ones" {
		t.Fatalf("after UpdateProfile: %+v", got)
	}

	// Signing in again relinks it by index.
	fromNuvio := Profile{Name: "Kids", NuvioIndex: kid.NuvioIndex, PinEnabled: true}
	linked := must[[]Profile](t)(s.LinkNuvioProfiles("user:me", []Profile{fromNuvio}))
	if !linked[0].Kids || linked[0].ID != kid.ID {
		t.Fatalf("after relinking: %+v", linked[0])
	}
	if got := must[Profile](t)(s.Profile(kid.ID)); !got.Kids {
		t.Fatalf("stored after relinking: %+v", got)
	}
	equal(t, must[KidsScope](t)(s.KidsScope(kid.ID)), KidsScope{Addons: []string{disney.URL}, Catalogs: []CatalogRef{}})
}

func TestLeavingAKidsProfileFromTheStoreService(t *testing.T) {
	s, _ := openTemp(t)
	kid := kidsProfile(t, s)
	other := must[Profile](t)(s.CreateProfile(Profile{Name: "Parent"}))
	service := &Service{store: s}

	check(t, s.SetCurrentProfile(kid.ID))
	if err := service.SetCurrentProfile(other.ID); !errors.Is(err, ErrKidsProfile) {
		t.Fatalf("SetCurrentProfile: err = %v, want ErrKidsProfile", err)
	}
	if _, err := service.SwitchToGuest(); !errors.Is(err, ErrKidsProfile) {
		t.Fatalf("SwitchToGuest: err = %v, want ErrKidsProfile", err)
	}
	if current := must[Profile](t)(s.CurrentProfile()); current.ID != kid.ID {
		t.Fatalf("current = %+v, want the kids profile", current)
	}

	// From any other profile, switching is free.
	check(t, s.SetCurrentProfile(other.ID))
	check(t, service.SetCurrentProfile(kid.ID))
}
