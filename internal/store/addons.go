package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
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
	return s.editAddons(id, func(addons []Addon) ([]Addon, error) {
		if indexOfAddon(addons, addon.URL) >= 0 {
			return nil, fmt.Errorf("%w: %s", ErrAddonInstalled, addon.URL)
		}
		return append(addons, addon), nil
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
	return s.update(id, func(p *bolt.Bucket) error {
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
		base := json.RawMessage(bytes.Clone(before))
		if queued := p.Bucket(bucketOutbox).Get(joinKey(string(SurfaceAddons), "")); queued != nil {
			var push Push
			if err := json.Unmarshal(queued, &push); err != nil {
				return err
			}
			base = push.Base
		}
		if err := p.Put(keyAddons, data); err != nil {
			return err
		}
		return queue(p, Push{Surface: SurfaceAddons, Op: OpUpsert, Item: data, Base: base})
	})
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
