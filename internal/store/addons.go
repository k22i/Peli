package store

import (
	"encoding/json"
	"fmt"

	bolt "go.etcd.io/bbolt"
)

// Addon is an installed Stremio addon, by its manifest URL. A profile's addons
// are an ordered list, saved whole: Nuvio replaces the whole list on push too.
type Addon struct {
	URL     string `json:"url"`
	Name    string `json:"name,omitempty"`
	Enabled bool   `json:"enabled"`
}

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
	if addons == nil {
		addons = []Addon{}
	}
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
	return s.update(id, func(p *bolt.Bucket) error {
		if err := put(p, keyAddons, addons); err != nil {
			return err
		}
		return enqueue(p, SurfaceAddons, OpUpsert, "", addons)
	})
}
