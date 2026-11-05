package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"slices"

	bolt "go.etcd.io/bbolt"
)

// Addon is an installed Stremio addon, by its manifest URL. A profile's addons
// are an ordered list, saved whole: Nuvio replaces the whole list on push too.
//
// An addon whose manifest doesn't load stays in the list: the error is shown
// where the manifest is read, and the entry is never dropped for it, or the
// next push would delete it on every device (#32).
type Addon struct {
	URL     string `json:"url"`
	Name    string `json:"name,omitempty"`
	Enabled bool   `json:"enabled"`
}

var (
	// ErrAddonInstalled means the addon's manifest URL is already in the
	// profile's list.
	ErrAddonInstalled = errors.New("store: addon is already installed")
	// ErrAddonNotFound means the profile has no addon at that manifest URL.
	ErrAddonNotFound = errors.New("store: addon not found")
)

// Addons returns profile id's addons in order.
func (s *Store) Addons(id uint64) ([]Addon, error) {
	addons := []Addon{}
	err := s.view(id, func(p *bolt.Bucket) error {
		if data := p.Get(keyAddons); data != nil {
			return json.Unmarshal(data, &addons)
		}
		return nil
	})
	return addons, err
}

// SetAddons replaces profile id's addons with addons, in that order.
func (s *Store) SetAddons(id uint64, addons []Addon) error {
	return s.editAddons(id, func([]Addon) ([]Addon, error) { return addons, nil })
}

// InstallAddon adds addon at the end of profile id's list.
func (s *Store) InstallAddon(id uint64, addon Addon) error {
	return s.InsertAddon(id, addon, math.MaxInt)
}

// InsertAddon adds addon at position at (from 0) in profile id's list,
// clamped to the list: the addon manager's undo puts a removed addon back
// where it was (#38).
func (s *Store) InsertAddon(id uint64, addon Addon, at int) error {
	return s.editAddons(id, func(addons []Addon) ([]Addon, error) {
		if indexOfAddon(addons, addon.URL) >= 0 {
			return nil, fmt.Errorf("%w: %s", ErrAddonInstalled, addon.URL)
		}
		return slices.Insert(addons, min(max(at, 0), len(addons)), addon), nil
	})
}

// ReplaceAddon puts addon in the place of the addon at manifest URL url,
// keeping whether it is on: a reconfigured addon has a new manifest URL, with
// the new config in its path (#38). A kids profile's allow-list follows the
// new URL, so the addon stays allowed.
func (s *Store) ReplaceAddon(id uint64, url string, addon Addon) error {
	return s.update(id, func(p *bolt.Bucket) error {
		err := editAddonList(p, func(addons []Addon) ([]Addon, error) {
			i := indexOfAddon(addons, url)
			if i < 0 {
				return nil, fmt.Errorf("%w: %s", ErrAddonNotFound, url)
			}
			if addon.URL != url && indexOfAddon(addons, addon.URL) >= 0 {
				return nil, fmt.Errorf("%w: %s", ErrAddonInstalled, addon.URL)
			}
			addon.Enabled = addons[i].Enabled
			addons[i] = addon
			return addons, nil
		})
		if err != nil || addon.URL == url || p.Get(keyKids) == nil {
			return err
		}
		var scope KidsScope
		if err := decodeOnto(p.Get(keyKids), &scope); err != nil {
			return err
		}
		// A stale entry for the new URL, left by a removal, would allow it
		// even if the old one wasn't.
		scope.Addons = slices.DeleteFunc(scope.Addons, func(a string) bool { return a == addon.URL })
		if i := slices.Index(scope.Addons, url); i >= 0 {
			scope.Addons[i] = addon.URL
		}
		for i := range scope.Catalogs {
			if scope.Catalogs[i].Addon == url {
				scope.Catalogs[i].Addon = addon.URL
			}
		}
		return put(p, keyKids, scope)
	})
}

// RemoveAddon removes the addon at manifest URL url from profile id's list.
func (s *Store) RemoveAddon(id uint64, url string) error {
	return s.editAddons(id, func(addons []Addon) ([]Addon, error) {
		i := indexOfAddon(addons, url)
		if i < 0 {
			return nil, fmt.Errorf("%w: %s", ErrAddonNotFound, url)
		}
		return slices.Delete(addons, i, i+1), nil
	})
}

// MoveAddon moves the addon at manifest URL url to position to (from 0) in
// profile id's list, clamped to the list.
func (s *Store) MoveAddon(id uint64, url string, to int) error {
	return s.editAddons(id, func(addons []Addon) ([]Addon, error) {
		i := indexOfAddon(addons, url)
		if i < 0 {
			return nil, fmt.Errorf("%w: %s", ErrAddonNotFound, url)
		}
		addon := addons[i]
		addons = slices.Delete(addons, i, i+1)
		return slices.Insert(addons, min(max(to, 0), len(addons)), addon), nil
	})
}

// EnableAddon turns the addon at manifest URL url on or off.
func (s *Store) EnableAddon(id uint64, url string, enabled bool) error {
	return s.editAddons(id, func(addons []Addon) ([]Addon, error) {
		i := indexOfAddon(addons, url)
		if i < 0 {
			return nil, fmt.Errorf("%w: %s", ErrAddonNotFound, url)
		}
		addons[i].Enabled = enabled
		return addons, nil
	})
}

func indexOfAddon(addons []Addon, url string) int {
	return slices.IndexFunc(addons, func(a Addon) bool { return a.URL == url })
}

// editAddons changes profile id's list with edit, in one transaction, and
// queues the whole new list for push. An edit that changes nothing queues
// nothing. The push carries the list the backend last had as its base: the
// list before this edit, or the base of a push still queued, whose edits this
// list includes.
func (s *Store) editAddons(id uint64, edit func([]Addon) ([]Addon, error)) error {
	return s.update(id, func(p *bolt.Bucket) error { return editAddonList(p, edit) })
}

// editAddonList is editAddons within a transaction, on profile bucket p.
func editAddonList(p *bolt.Bucket, edit func([]Addon) ([]Addon, error)) error {
	before := p.Get(keyAddons)
	addons := []Addon{}
	if before != nil {
		if err := json.Unmarshal(before, &addons); err != nil {
			return err
		}
	} else {
		before = []byte("[]")
	}
	addons, err := edit(addons)
	if err != nil {
		return err
	}
	if addons == nil {
		addons = []Addon{}
	}
	if err := validateAddons(addons); err != nil {
		return err
	}
	data, err := json.Marshal(addons)
	if err != nil {
		return err
	}
	if bytes.Equal(data, before) {
		return nil
	}
	if err := p.Put(keyAddons, data); err != nil {
		return err
	}
	// Built-in addons stay on this device (#107): an edit of only them
	// changes nothing Nuvio has.
	var was []Addon
	if err := json.Unmarshal(before, &was); err != nil {
		return err
	}
	if slices.Equal(SyncedAddons(was), SyncedAddons(addons)) {
		return nil
	}
	base := json.RawMessage(bytes.Clone(before))
	if queued := p.Bucket(bucketOutbox).Get(joinKey(string(SurfaceAddons), "")); queued != nil {
		var push Push
		if err := json.Unmarshal(queued, &push); err != nil {
			return err
		}
		base = push.Base
	}
	return queue(p, Push{Surface: SurfaceAddons, Op: OpUpsert, Item: data, Base: base})
}

func validateAddons(addons []Addon) error {
	seen := map[string]bool{}
	for _, addon := range addons {
		if addon.URL == "" {
			return fmt.Errorf("%w: addon needs a URL", ErrInvalidItem)
		}
		if seen[addon.URL] {
			return fmt.Errorf("%w: addon %s is listed twice", ErrInvalidItem, addon.URL)
		}
		seen[addon.URL] = true
	}
	return nil
}
