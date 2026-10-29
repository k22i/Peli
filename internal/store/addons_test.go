package store

import (
	"encoding/json"
	"errors"
	"testing"
)

var subtitles = Addon{URL: "https://opensubtitles-v3.strem.io/manifest.json", Name: "OpenSubtitles", Enabled: true}

// addonsPush returns the one queued addons push, with its list and base.
func addonsPush(t *testing.T, s *Store, id uint64) (list, base []Addon) {
	t.Helper()
	var found *Push
	for _, p := range must[[]Push](t)(s.Pending(id)) {
		if p.Surface == SurfaceAddons {
			if found != nil {
				t.Fatal("two addons pushes queued")
			}
			found = &p
		}
	}
	if found == nil {
		t.Fatal("no addons push queued")
	}
	check(t, json.Unmarshal(found.Item, &list))
	check(t, json.Unmarshal(found.Base, &base))
	return list, base
}

// The addon manager's edits change the stored list in place and queue the
// whole new list (#32).
func TestAddonEdits(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	id := linked.ID

	check(t, s.InstallAddon(id, cinemeta))
	check(t, s.InstallAddon(id, subtitles))
	check(t, s.InstallAddon(id, disney))
	if err := s.InstallAddon(id, cinemeta); !errors.Is(err, ErrAddonInstalled) {
		t.Fatalf("installing twice: err = %v", err)
	}
	check(t, s.MoveAddon(id, disney.URL, 0))
	check(t, s.EnableAddon(id, subtitles.URL, false))
	check(t, s.RemoveAddon(id, cinemeta.URL))
	off := subtitles
	off.Enabled = false
	equal(t, must[[]Addon](t)(s.Addons(id)), []Addon{disney, off})

	// Out of range moves land at an end.
	check(t, s.MoveAddon(id, disney.URL, 99))
	equal(t, must[[]Addon](t)(s.Addons(id)), []Addon{off, disney})
	check(t, s.MoveAddon(id, disney.URL, -1))
	equal(t, must[[]Addon](t)(s.Addons(id)), []Addon{disney, off})

	for _, err := range []error{
		s.RemoveAddon(id, "https://nope/manifest.json"),
		s.MoveAddon(id, "https://nope/manifest.json", 0),
		s.EnableAddon(id, "https://nope/manifest.json", true),
	} {
		if !errors.Is(err, ErrAddonNotFound) {
			t.Fatalf("editing a missing addon: err = %v", err)
		}
	}
	if err := s.InstallAddon(id, Addon{Name: "No URL"}); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("installing without a URL: err = %v", err)
	}

	// One push, of the whole list, from the list the backend last had: none.
	list, base := addonsPush(t, s, id)
	equal(t, list, []Addon{disney, off})
	equal(t, base, []Addon{})
}

// Undo puts a removed addon back in its place; reconfiguring swaps the URL
// in place, keeping it on or off and allowed for a kids profile (#38).
func TestInsertAndReplaceAddon(t *testing.T) {
	s, _ := openTemp(t)
	kid := must[Profile](t)(s.CreateProfile(Profile{Name: "Kid", NuvioIndex: ptr(2), Kids: true}))
	id := kid.ID
	check(t, s.SetAddons(id, []Addon{cinemeta, subtitles, disney}))
	check(t, s.SetKidsScope(id, KidsScope{
		Addons:   []string{subtitles.URL, "https://opensubtitles-v3.strem.io/lang=eng/manifest.json"},
		Catalogs: []CatalogRef{{Addon: subtitles.URL, Type: "movie", ID: "top"}},
	}))

	check(t, s.RemoveAddon(id, subtitles.URL))
	check(t, s.InsertAddon(id, subtitles, 1))
	equal(t, must[[]Addon](t)(s.Addons(id)), []Addon{cinemeta, subtitles, disney})
	check(t, s.InsertAddon(id, Addon{URL: "https://last/manifest.json"}, 99))
	if err := s.InsertAddon(id, cinemeta, 0); !errors.Is(err, ErrAddonInstalled) {
		t.Fatalf("inserting twice: err = %v", err)
	}
	check(t, s.RemoveAddon(id, "https://last/manifest.json"))

	check(t, s.EnableAddon(id, subtitles.URL, false))
	english := Addon{URL: "https://opensubtitles-v3.strem.io/lang=eng/manifest.json", Name: "OpenSubtitles (English)", Enabled: true}
	check(t, s.ReplaceAddon(id, subtitles.URL, english))
	english.Enabled = false
	equal(t, must[[]Addon](t)(s.Addons(id)), []Addon{cinemeta, english, disney})
	equal(t, must[KidsScope](t)(s.KidsScope(id)), KidsScope{
		Addons:   []string{english.URL},
		Catalogs: []CatalogRef{{Addon: english.URL, Type: "movie", ID: "top"}},
	})

	if err := s.ReplaceAddon(id, english.URL, cinemeta); !errors.Is(err, ErrAddonInstalled) {
		t.Fatalf("replacing with an installed URL: err = %v", err)
	}
	if err := s.ReplaceAddon(id, "https://nope/manifest.json", cinemeta); !errors.Is(err, ErrAddonNotFound) {
		t.Fatalf("replacing a missing addon: err = %v", err)
	}
	// Same URL, new name: the scope is untouched.
	check(t, s.ReplaceAddon(id, cinemeta.URL, Addon{URL: cinemeta.URL, Name: "Cinemeta 3"}))
	equal(t, must[[]Addon](t)(s.Addons(id))[0], Addon{URL: cinemeta.URL, Name: "Cinemeta 3", Enabled: true})
}

// The push's base is the list before the first edit that hasn't been sent,
// so the backend can merge it (ADR-0019); an edit that changes nothing queues
// nothing.
func TestAddonsPushBase(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	id := linked.ID
	pulled := []Addon{cinemeta, subtitles}
	equal(t, must[int](t)(s.ApplyChanges(id, []Change{change(t, SurfaceAddons, OpUpsert, pulled)})), 1)

	check(t, s.SetAddons(id, pulled))
	equal(t, must[[]Push](t)(s.Pending(id)), []Push{})

	check(t, s.RemoveAddon(id, cinemeta.URL))
	check(t, s.InstallAddon(id, disney))
	list, base := addonsPush(t, s, id)
	equal(t, list, []Addon{subtitles, disney})
	equal(t, base, pulled)

	// Once sent, the next edit starts from the list as it was sent.
	for _, p := range must[[]Push](t)(s.Pending(id)) {
		check(t, s.AckPush(id, p))
	}
	check(t, s.MoveAddon(id, disney.URL, 0))
	_, base = addonsPush(t, s, id)
	equal(t, base, []Addon{subtitles, disney})
}

// A local-only profile's edits stay here.
func TestAddonEditsOfALocalProfile(t *testing.T) {
	s, _ := openTemp(t)
	guest := must[Profile](t)(s.CreateProfile(Profile{Name: "Guest", Guest: true}))
	check(t, s.InstallAddon(guest.ID, cinemeta))
	equal(t, must[[]Addon](t)(s.Addons(guest.ID)), []Addon{cinemeta})
	equal(t, must[[]Push](t)(s.Pending(guest.ID)), []Push{})
}

// A pull of an empty list into a profile that never had one changes nothing.
func TestApplyEmptyAddons(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	equal(t, must[int](t)(s.ApplyChanges(linked.ID, []Change{change(t, SurfaceAddons, OpUpsert, []Addon{})})), 0)
}
