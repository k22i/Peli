package store

import (
	"bytes"
	"encoding/json"
	"fmt"

	bolt "go.etcd.io/bbolt"
)

// Change is one item from a backend's delta feed, to apply to the local store
// without queuing a push (ApplyChanges).
type Change struct {
	Surface Surface `json:"surface"`
	Op      Op      `json:"op"`
	// The item's key as a push names it. ApplyChanges works the key out from
	// Item again, so it only has to be right for a reader.
	Key string `json:"key"`
	// The item as the backend has it, or as it was before a delete. For the
	// addons surface, the whole list: addons have no delta feed.
	Item json.RawMessage `json:"item"`
}

// ApplyChanges writes changes from a backend's feed to profile id, in one
// transaction, and returns how many of them changed anything. Unlike the
// write methods it queues no push: the change came from the backend.
//
// It is meant to be applied again and again. The feed echoes our own writes
// back, without the origin to tell them apart, so a change that matches what
// is stored does nothing. A change to an item with a push still queued is
// skipped: the user changed it here since, and the push will overwrite the
// backend's copy. (An echo of an earlier write must not undo that newer one.)
//
// Conflicts. Library and watched items have no timestamp worth comparing, so
// the backend's copy wins, unless a push is queued as above. Progress is the
// one that is edited from several devices at once, and the backend drops
// pushes that come too soon after the last (a 200 all the same), so a pull
// can bring back an older position than ours that we thought was saved. Its
// rule is latest lastWatched wins: a change older than the stored entry is
// skipped, a delete too (a delete carries the row as it was, and an entry
// watched again since is not that row). Equal times take the backend's copy.
func (s *Store) ApplyChanges(id uint64, changes []Change) (applied int, err error) {
	err = s.update(id, func(p *bolt.Bucket) error {
		applied = 0
		for _, c := range changes {
			ok, err := applyChange(p, c)
			if err != nil {
				return fmt.Errorf("%w: %s %s: %v", ErrInvalidItem, c.Surface, c.Op, err)
			}
			if ok {
				applied++
			}
		}
		return nil
	})
	return applied, err
}

// target is where a change goes: a bucket (nil: the profile bucket itself),
// the key in it and the key of its push.
type target struct {
	bucket  []byte
	key     []byte
	pushKey string
	// The value to store; nil for a delete.
	value any
	// For progress, when the item was last watched: the later of two copies
	// wins, whatever order they arrive in.
	watchedAt *int64
}

func applyChange(p *bolt.Bucket, c Change) (bool, error) {
	if c.Op != OpUpsert && c.Op != OpDelete {
		return false, fmt.Errorf("unknown operation")
	}
	t, err := targetOf(c)
	if err != nil {
		return false, err
	}
	if p.Bucket(bucketOutbox).Get(joinKey(string(c.Surface), t.pushKey)) != nil {
		return false, nil
	}
	dest := p
	if t.bucket != nil {
		dest = p.Bucket(t.bucket)
	}
	have := dest.Get(t.key)
	if t.watchedAt != nil && have != nil {
		var stored Progress
		if err := json.Unmarshal(have, &stored); err != nil {
			return false, err
		}
		if stored.LastWatched > *t.watchedAt {
			return false, nil
		}
	}
	if c.Op == OpDelete {
		if have == nil {
			return false, nil
		}
		return true, dest.Delete(t.key)
	}
	want, err := json.Marshal(t.value)
	if err != nil {
		return false, err
	}
	if bytes.Equal(have, want) {
		return false, nil
	}
	return true, dest.Put(t.key, want)
}

// targetOf decodes c's item and works out where it lives.
func targetOf(c Change) (target, error) {
	switch c.Surface {
	case SurfaceLibrary:
		var item LibraryItem
		if err := json.Unmarshal(c.Item, &item); err != nil {
			return target{}, err
		}
		if item.ContentID == "" || item.ContentType == "" {
			return target{}, fmt.Errorf("library item needs a content ID and type")
		}
		key := libraryKey(item.ContentID, item.ContentType)
		return target{bucketLibrary, []byte(key), key, item, nil}, nil
	case SurfaceProgress:
		var entry Progress
		if err := json.Unmarshal(c.Item, &entry); err != nil {
			return target{}, err
		}
		if entry.ContentID == "" || entry.ContentType == "" {
			return target{}, fmt.Errorf("progress needs a content ID and type")
		}
		if entry.VideoID == "" {
			entry.VideoID = entry.ContentID
		}
		if entry.Key == "" {
			entry.Key = ProgressKey(entry.ContentID, entry.Season, entry.Episode)
		}
		return target{bucketProgress, []byte(entry.Key), entry.Key, entry, &entry.LastWatched}, nil
	case SurfaceWatched:
		var item WatchedItem
		if err := json.Unmarshal(c.Item, &item); err != nil {
			return target{}, err
		}
		if item.ContentID == "" || item.ContentType == "" {
			return target{}, fmt.Errorf("watched item needs a content ID and type")
		}
		return target{bucketWatched, watchedKey(item.ContentID, item.Season, item.Episode),
			watchedPushKey(item.ContentID, item.Season, item.Episode), item, nil}, nil
	case SurfaceAddons:
		addons := []Addon{}
		if err := json.Unmarshal(c.Item, &addons); err != nil {
			return target{}, err
		}
		if addons == nil {
			addons = []Addon{}
		}
		return target{nil, keyAddons, "", addons, nil}, nil
	}
	return target{}, fmt.Errorf("unknown surface")
}

// PushKey returns the key a push of item on surface has in the outbox: what
// Push.Key and Change.Key hold.
func PushKey(surface Surface, item json.RawMessage) (string, error) {
	t, err := targetOf(Change{Surface: surface, Item: item})
	return t.pushKey, err
}
