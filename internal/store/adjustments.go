package store

import (
	"fmt"

	bolt "go.etcd.io/bbolt"
)

// TitleAdjustments are how one title plays for a profile when it differs
// from the profile's defaults: changes made in the player's Picture & sound
// sheet stick to the title (a show's id for every episode, a film's own).
// Each section is nil while the title follows the defaults. They stay on
// this device: Nuvio has no field for them.
//
//	profiles/<id>
//	  titles/ <content id> → TitleAdjustments (made when first needed)
type TitleAdjustments struct {
	Picture *Picture `json:"picture,omitempty"`
	Framing *Framing `json:"framing,omitempty"`
	Quality *Quality `json:"quality,omitempty"`
	// Unix ms of the last change.
	ChangedAt int64 `json:"changedAt"`
}

func (a *TitleAdjustments) empty() bool {
	return a == nil || (a.Picture == nil && a.Framing == nil && a.Quality == nil)
}

func (a *TitleAdjustments) valid() bool {
	return (a.Picture == nil || a.Picture.Valid()) && (a.Framing == nil || a.Framing.Valid()) &&
		(a.Quality == nil || a.Quality.Valid())
}

var bucketTitles = []byte("titles")

// TitleAdjustments returns how profile id plays contentID when it isn't the
// defaults, or nil.
func (s *Store) TitleAdjustments(id uint64, contentID string) (*TitleAdjustments, error) {
	var adj *TitleAdjustments
	err := s.view(id, func(p *bolt.Bucket) error {
		b := p.Bucket(bucketTitles)
		if b == nil {
			return nil
		}
		data := b.Get([]byte(contentID))
		if data == nil {
			return nil
		}
		adj = &TitleAdjustments{}
		return decodeOnto(data, adj)
	})
	return adj, err
}

// SetTitleAdjustments keeps how profile id plays contentID, or forgets it
// when adj is nil or has no section left.
func (s *Store) SetTitleAdjustments(id uint64, contentID string, adj *TitleAdjustments) error {
	if contentID == "" {
		return fmt.Errorf("%w: title adjustments need a content ID", ErrInvalidItem)
	}
	if !adj.empty() && !adj.valid() {
		return fmt.Errorf("%w: title adjustments %+v", ErrInvalidSettings, *adj)
	}
	return s.update(id, func(p *bolt.Bucket) error {
		if adj.empty() {
			if b := p.Bucket(bucketTitles); b != nil {
				return b.Delete([]byte(contentID))
			}
			return nil
		}
		b, err := p.CreateBucketIfNotExists(bucketTitles)
		if err != nil {
			return err
		}
		return put(b, []byte(contentID), adj)
	})
}

// AdjustedTitles counts the titles profile id plays its own way.
func (s *Store) AdjustedTitles(id uint64) (int, error) {
	n := 0
	err := s.view(id, func(p *bolt.Bucket) error {
		if b := p.Bucket(bucketTitles); b != nil {
			n = b.Stats().KeyN
		}
		return nil
	})
	return n, err
}

// ClearTitleAdjustments has every title of profile id follow its defaults
// again.
func (s *Store) ClearTitleAdjustments(id uint64) error {
	return s.update(id, func(p *bolt.Bucket) error {
		if p.Bucket(bucketTitles) == nil {
			return nil
		}
		return p.DeleteBucket(bucketTitles)
	})
}
