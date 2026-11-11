package store

import (
	"encoding/json"
	"slices"
	"strings"

	bolt "go.etcd.io/bbolt"
)

// Built-in addons (#107, ADR-0045) run inside Peli at peli://<name>/…
// URLs. They are in a profile's addon list like any other, so the user can
// reorder, turn off or remove them, but they stay on this device: Nuvio's
// copy of the list never has them, since other devices can't reach them.

// AniListAddon is Peli's AniList addon (#108).
var AniListAddon = Addon{URL: "peli://anilist/manifest.json", Name: "AniList", Enabled: true}

// Builtins are the built-in addons the app offers each profile once, in
// order (UseBuiltins).
var Builtins = []Addon{AniListAddon}

// UseBuiltins has every profile offered addons once: the ones there are now,
// and each made from now on. The app passes Builtins at startup; a store
// opened without it, as in tests, offers none.
func (s *Store) UseBuiltins(addons []Addon) error {
	addons = slices.Clone(addons)
	s.offered.Store(&addons)
	return s.db.Update(func(tx *bolt.Tx) error {
		profiles := tx.Bucket(bucketProfiles)
		c := profiles.Cursor()
		for id, v := c.First(); id != nil; id, v = c.Next() {
			if v != nil {
				continue
			}
			if err := offerBuiltins(profiles.Bucket(id), addons); err != nil {
				return err
			}
		}
		return nil
	})
}

func (s *Store) builtins() []Addon {
	if offered := s.offered.Load(); offered != nil {
		return *offered
	}
	return nil
}

var keyBuiltinsOffered = []byte("builtins-offered")

// IsBuiltinAddon reports whether url is a built-in addon's.
func IsBuiltinAddon(url string) bool { return strings.HasPrefix(strings.ToLower(url), "peli://") }

// SyncedAddons returns addons without the built-in ones: the list Nuvio has.
func SyncedAddons(addons []Addon) []Addon {
	return slices.DeleteFunc(slices.Clone(addons), func(a Addon) bool { return IsBuiltinAddon(a.URL) })
}

// builtinAt is where a built-in addon goes in a list that doesn't say:
// before the first anime addon (Kitsu's), so AniList answers anime details
// first, or else last.
func builtinAt(addons []Addon) int {
	i := slices.IndexFunc(addons, func(a Addon) bool {
		return !IsBuiltinAddon(a.URL) && strings.Contains(strings.ToLower(a.URL), "kitsu")
	})
	if i < 0 {
		return len(addons)
	}
	return i
}

// keepBuiltins returns pulled, a list from Nuvio, with the built-in addons of
// have, this device's list, kept in their places: each after the addon it
// followed here, or where builtinAt puts it when no addon it followed is left.
func keepBuiltins(have, pulled []Addon) []Addon {
	out := SyncedAddons(pulled)
	for i, a := range have {
		if !IsBuiltinAddon(a.URL) {
			continue
		}
		at := -1
		for j := i - 1; j >= 0; j-- {
			if k := indexOfAddon(out, have[j].URL); k >= 0 {
				at = k + 1
				break
			}
		}
		if at < 0 {
			at = 0
			if !slices.ContainsFunc(have[i+1:], func(next Addon) bool { return indexOfAddon(out, next.URL) >= 0 }) {
				at = builtinAt(out)
			}
		}
		out = slices.Insert(out, at, a)
	}
	return out
}

// offerBuiltins adds the built-in addons profile bucket p hasn't been offered
// yet, and remembers them, so one the user removed stays removed. It queues
// no push: Nuvio's list doesn't change.
func offerBuiltins(p *bolt.Bucket, builtins []Addon) error {
	offered := []string{}
	if err := decodeOnto(p.Get(keyBuiltinsOffered), &offered); err != nil {
		return err
	}
	addons := []Addon{}
	if data := p.Get(keyAddons); data != nil {
		if err := json.Unmarshal(data, &addons); err != nil {
			return err
		}
	}
	changed := false
	for _, b := range builtins {
		if slices.Contains(offered, b.URL) {
			continue
		}
		offered = append(offered, b.URL)
		if indexOfAddon(addons, b.URL) < 0 {
			addons = slices.Insert(addons, builtinAt(addons), b)
			changed = true
		}
	}
	if changed {
		if err := put(p, keyAddons, addons); err != nil {
			return err
		}
	}
	if len(builtins) == 0 {
		return nil
	}
	return put(p, keyBuiltinsOffered, offered)
}
