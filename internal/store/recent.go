package store

import (
	"fmt"
	"strings"

	bolt "go.etcd.io/bbolt"
)

// MaxRecentSearches is how many searches a profile keeps.
const MaxRecentSearches = 8

var keyRecentSearches = []byte("recent-searches")

// RecentSearches returns profile id's last searches, newest first. They stay
// on this device: Nuvio has nothing to sync them with.
//
//	profiles/<id>
//	  recent-searches → []string
func (s *Store) RecentSearches(id uint64) ([]string, error) {
	recent := []string{}
	err := s.view(id, func(p *bolt.Bucket) error {
		return decodeOnto(p.Get(keyRecentSearches), &recent)
	})
	if len(recent) > MaxRecentSearches {
		recent = recent[:MaxRecentSearches]
	}
	return recent, err
}

// SetRecentSearches replaces profile id's recent searches (newest first); an
// empty list forgets them.
func (s *Store) SetRecentSearches(id uint64, recent []string) error {
	if len(recent) > MaxRecentSearches {
		return fmt.Errorf("%w: %d recent searches", ErrInvalidItem, len(recent))
	}
	for _, term := range recent {
		if strings.TrimSpace(term) == "" {
			return fmt.Errorf("%w: an empty recent search", ErrInvalidItem)
		}
	}
	return s.update(id, func(p *bolt.Bucket) error {
		if len(recent) == 0 {
			return p.Delete(keyRecentSearches)
		}
		return put(p, keyRecentSearches, recent)
	})
}
