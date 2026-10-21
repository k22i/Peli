package store

import (
	"encoding/binary"
	"fmt"
	"strconv"

	bolt "go.etcd.io/bbolt"
)

// WatchedItem marks a film, a whole series or an episode as watched. Fields
// follow Nuvio's watched_items; times are ms since epoch.
type WatchedItem struct {
	ContentID   string `json:"contentId"`
	ContentType string `json:"contentType"`
	Title       string `json:"title,omitempty"`
	Season      *int   `json:"season,omitempty"`
	Episode     *int   `json:"episode,omitempty"`
	WatchedAt   int64  `json:"watchedAt"`
}

// watchedKey sorts a title's episodes by season and episode, after the title
// itself. Nuvio's key is the same (content ID, season, episode).
func watchedKey(contentID string, season, episode *int) []byte {
	key := joinKey(contentID, "")
	for _, n := range []*int{season, episode} {
		var v uint32 // nil sorts first
		if n != nil {
			v = uint32(*n) + 1
		}
		key = binary.BigEndian.AppendUint32(key, v)
	}
	return key
}

// watchedPushKey names a watched item in the outbox as text. The bucket key
// is binary, which JSON turns into U+FFFD from episode 127 on, and then the
// push could never be acked.
func watchedPushKey(contentID string, season, episode *int) string {
	number := func(n *int) string {
		if n == nil {
			return ""
		}
		return strconv.Itoa(*n)
	}
	return string(joinKey(contentID, number(season), number(episode)))
}

// Watched returns everything profile id has watched, grouped by title.
func (s *Store) Watched(id uint64) ([]WatchedItem, error) {
	items := []WatchedItem{}
	err := s.view(id, func(p *bolt.Bucket) error {
		return each(p.Bucket(bucketWatched), func(item WatchedItem) { items = append(items, item) })
	})
	return items, err
}

// TitleWatched returns what profile id has watched of one title: the title
// itself and its episodes, in season and episode order.
func (s *Store) TitleWatched(id uint64, contentID string) ([]WatchedItem, error) {
	items := []WatchedItem{}
	err := s.view(id, func(p *bolt.Bucket) error {
		return eachPrefix(p.Bucket(bucketWatched), joinKey(contentID, ""), func(item WatchedItem) {
			items = append(items, item)
		})
	})
	return items, err
}

// MarkWatched marks item watched for profile id.
func (s *Store) MarkWatched(id uint64, item WatchedItem) error {
	if item.ContentID == "" || item.ContentType == "" {
		return fmt.Errorf("%w: watched item needs a content ID and type", ErrInvalidItem)
	}
	key := watchedKey(item.ContentID, item.Season, item.Episode)
	return s.update(id, func(p *bolt.Bucket) error {
		if err := put(p.Bucket(bucketWatched), key, item); err != nil {
			return err
		}
		return enqueue(p, SurfaceWatched, OpUpsert, watchedPushKey(item.ContentID, item.Season, item.Episode), item)
	})
}

// UnmarkWatched removes a watched mark from profile id.
func (s *Store) UnmarkWatched(id uint64, contentID string, season, episode *int) error {
	key := watchedKey(contentID, season, episode)
	return s.update(id, func(p *bolt.Bucket) error {
		return remove(p, bucketWatched, SurfaceWatched, key, watchedPushKey(contentID, season, episode))
	})
}
