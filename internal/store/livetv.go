package store

import (
	"cmp"
	"errors"
	"fmt"
	"slices"
	"strings"

	bolt "go.etcd.io/bbolt"
)

// LiveSource is one Live TV source (ADR-0066): an M3U playlist and, perhaps,
// an XMLTV guide. Only what is safe to keep in a file is here: the URLs are
// in the keychain (internal/livetv), the parsed channels in the cache. A
// source belongs to one profile and stays on this device, never synced to
// Nuvio.
//
//	livetv <id> → LiveSource
type LiveSource struct {
	// ID is 16 hex characters, made at random.
	ID        string `json:"id"`
	ProfileID uint64 `json:"profileId"`
	Name      string `json:"name"`
	// Unix ms.
	CreatedAt int64 `json:"createdAt"`
	UpdatedAt int64 `json:"updatedAt"`
}

// ErrLiveSourceNotFound is what the methods that name one source return when
// there is none with that id.
var ErrLiveSourceNotFound = errors.New("store: live TV source not found")

// MaxLiveFavourites and MaxLiveRecent cap a profile's lists of channel ids.
const (
	MaxLiveFavourites = 500
	MaxLiveRecent     = 20
)

var (
	bucketLiveTV      = []byte("livetv")
	keyLiveFavourites = []byte("livetv-favourites")
	keyLiveRecent     = []byte("livetv-recent")
)

func (l LiveSource) validate() error {
	if l.ID == "" {
		return fmt.Errorf("%w: a live TV source needs an ID", ErrInvalidItem)
	}
	if l.ProfileID == 0 {
		return fmt.Errorf("%w: live TV source %s has no profile", ErrInvalidItem, l.ID)
	}
	if strings.TrimSpace(l.Name) == "" {
		return fmt.Errorf("%w: live TV source %s has no name", ErrInvalidItem, l.ID)
	}
	return nil
}

// AllLiveSources returns every profile's sources, oldest first.
func (s *Store) AllLiveSources() ([]LiveSource, error) {
	return s.liveSources(func(LiveSource) bool { return true })
}

// LiveSources returns profile id's sources, oldest first.
func (s *Store) LiveSources(id uint64) ([]LiveSource, error) {
	return s.liveSources(func(l LiveSource) bool { return l.ProfileID == id })
}

func (s *Store) liveSources(keep func(LiveSource) bool) ([]LiveSource, error) {
	sources := []LiveSource{}
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketLiveTV)
		if b == nil {
			return nil
		}
		return each(b, func(l LiveSource) {
			if keep(l) {
				sources = append(sources, l)
			}
		})
	})
	if err != nil {
		return nil, err
	}
	slices.SortFunc(sources, func(a, b LiveSource) int {
		if c := cmp.Compare(a.CreatedAt, b.CreatedAt); c != 0 {
			return c
		}
		return cmp.Compare(a.ID, b.ID)
	})
	return sources, nil
}

// LiveSource returns the source with this id, or ErrLiveSourceNotFound.
func (s *Store) LiveSource(id string) (LiveSource, error) {
	var source LiveSource
	found := false
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketLiveTV)
		if b == nil {
			return nil
		}
		data := b.Get([]byte(id))
		if data == nil {
			return nil
		}
		found = true
		return decodeOnto(data, &source)
	})
	if err != nil {
		return LiveSource{}, err
	}
	if !found {
		return LiveSource{}, fmt.Errorf("%w: %s", ErrLiveSourceNotFound, id)
	}
	return source, nil
}

// PutLiveSource inserts or replaces a source, keyed by its ID. One with no
// ID, profile or name is refused (ErrInvalidItem), as is one for a profile
// that isn't there (ErrProfileNotFound).
func (s *Store) PutLiveSource(l LiveSource) error {
	if err := l.validate(); err != nil {
		return err
	}
	return s.db.Update(func(tx *bolt.Tx) error {
		if _, err := profileBucket(tx, l.ProfileID); err != nil {
			return err
		}
		b, err := tx.CreateBucketIfNotExists(bucketLiveTV)
		if err != nil {
			return err
		}
		return put(b, []byte(l.ID), l)
	})
}

// DeleteLiveSource removes a source's record. A missing id is not an error.
func (s *Store) DeleteLiveSource(id string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketLiveTV)
		if b == nil {
			return nil
		}
		return b.Delete([]byte(id))
	})
}

// LiveFavourites returns profile id's favourite channel ids, in the order
// they were added.
//
//	profiles/<id>
//	  livetv-favourites → []string
//	  livetv-recent     → []string (newest first)
func (s *Store) LiveFavourites(id uint64) ([]string, error) {
	return s.channelList(id, keyLiveFavourites)
}

// SetLiveFavourites replaces profile id's favourite channels.
func (s *Store) SetLiveFavourites(id uint64, channels []string) error {
	return s.setChannelList(id, keyLiveFavourites, channels, MaxLiveFavourites)
}

// LiveRecent returns the channels profile id watched last, newest first.
func (s *Store) LiveRecent(id uint64) ([]string, error) {
	return s.channelList(id, keyLiveRecent)
}

// SetLiveRecent replaces profile id's recent channels (newest first).
func (s *Store) SetLiveRecent(id uint64, channels []string) error {
	return s.setChannelList(id, keyLiveRecent, channels, MaxLiveRecent)
}

func (s *Store) channelList(id uint64, key []byte) ([]string, error) {
	list := []string{}
	err := s.view(id, func(p *bolt.Bucket) error {
		return decodeOnto(p.Get(key), &list)
	})
	return list, err
}

func (s *Store) setChannelList(id uint64, key []byte, channels []string, limit int) error {
	if len(channels) > limit {
		return fmt.Errorf("%w: %d channels, at most %d", ErrInvalidItem, len(channels), limit)
	}
	for _, channel := range channels {
		if channel == "" {
			return fmt.Errorf("%w: an empty channel id", ErrInvalidItem)
		}
	}
	return s.update(id, func(p *bolt.Bucket) error {
		if len(channels) == 0 {
			return p.Delete(key)
		}
		return put(p, key, channels)
	})
}
