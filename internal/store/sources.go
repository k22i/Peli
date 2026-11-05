package store

import (
	"fmt"

	bolt "go.etcd.io/bbolt"
)

// ChosenSource (#58, F19) is the stream source a profile last played a show
// from, as a fingerprint the next episode's streams can match: the addon (or
// plugin) and the file's quality and release group, as the ranking engine
// read them. It stays on this device: Nuvio has nothing to sync it with, and
// the addon URLs it names are this device's install.
//
//	profiles/<id>
//	  sources/ <content id> → ChosenSource (made when first needed)
type ChosenSource struct {
	// The source's key in the picker: an addon's URL, or "plugin:<id>".
	Source string `json:"source"`
	// "1080p", "2160p" and so on, or "" when the stream didn't say.
	Resolution string `json:"resolution"`
	// The release group, or "" when the stream didn't say.
	Group string `json:"group"`
	// Unix ms.
	ChosenAt int64 `json:"chosenAt"`
}

var bucketSources = []byte("sources")

// ChosenSource returns the source profile id last played contentID (a show's
// id, not an episode's) from, or nil for none.
func (s *Store) ChosenSource(id uint64, contentID string) (*ChosenSource, error) {
	var chosen *ChosenSource
	err := s.view(id, func(p *bolt.Bucket) error {
		b := p.Bucket(bucketSources)
		if b == nil {
			return nil
		}
		data := b.Get([]byte(contentID))
		if data == nil {
			return nil
		}
		chosen = &ChosenSource{}
		return decodeOnto(data, chosen)
	})
	return chosen, err
}

// SetChosenSource remembers the source profile id played contentID from, or
// forgets it when chosen is nil.
func (s *Store) SetChosenSource(id uint64, contentID string, chosen *ChosenSource) error {
	if contentID == "" {
		return fmt.Errorf("%w: a chosen source needs a content ID", ErrInvalidItem)
	}
	if chosen != nil && chosen.Source == "" {
		return fmt.Errorf("%w: a chosen source needs its source", ErrInvalidItem)
	}
	return s.update(id, func(p *bolt.Bucket) error {
		if chosen == nil {
			if b := p.Bucket(bucketSources); b != nil {
				return b.Delete([]byte(contentID))
			}
			return nil
		}
		b, err := p.CreateBucketIfNotExists(bucketSources)
		if err != nil {
			return err
		}
		return put(b, []byte(contentID), chosen)
	})
}
