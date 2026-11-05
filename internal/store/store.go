// Package store is Sinag's local database: profiles, their library, watch
// progress, watched items, addons, plugin repositories (#57), home layout, collections, settings and
// the source each show was last played from (#58), the device's settings,
// the sync bookkeeping (#28) and a cache.
// It is one bbolt file in the OS app-data directory (ADR-0006).
//
// Layout: every profile has its own bucket under "profiles", and everything
// that belongs to a profile lives inside it, so a profile can only read its
// own data and deleting a profile deletes all of it. Values are JSON.
//
//	meta               schema → uint64
//	profiles/<id>      profile → Profile
//	                   addons → []Addon
//	                   plugin-repos → []PluginRepo (synced, #57)
//	                   plugin-config → PluginConfig (local, #57)
//	                   settings → ProfileSettings
//	                   home-layout → Nuvio's home layout blob (#35)
//	                   collections → Nuvio's collections blob (#35)
//	                   tracking → Tracking: SIMKL and AniList (#71)
//	  library/         <content id> 0x00 <content type> → LibraryItem
//	  progress/        <progress key> → Progress
//	  watched/         <content id> 0x00 <season+1> <episode+1> → WatchedItem
//	  cursors/         <surface> → int64
//	  outbox/          <surface> 0x00 <key> → Push
//	  tracking-outbox/ <sequence> → TrackingJob (made when first needed)
//	  sources/         <content id> → ChosenSource (#58, made when first needed)
//	settings           device → DeviceSettings
//	                   current → uint64 (profile id)
//	                   account → string (the linked Nuvio account's user id)
//	                   tracking-token-owners → []uint64 (profiles with tokens)
//	cache              <key> → bytes
package store

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync/atomic"
	"time"

	bolt "go.etcd.io/bbolt"
)

var (
	bucketMeta     = []byte("meta")
	bucketProfiles = []byte("profiles")
	bucketCache    = []byte("cache")
	bucketSettings = []byte("settings")

	bucketLibrary  = []byte("library")
	bucketProgress = []byte("progress")
	bucketWatched  = []byte("watched")
	bucketCursors  = []byte("cursors")
	bucketOutbox   = []byte("outbox")

	keySchema  = []byte("schema")
	keyProfile = []byte("profile")
	keyAddons  = []byte("addons")

	keyPluginRepos  = []byte("plugin-repos")
	keyPluginConfig = []byte("plugin-config")
	keySettings     = []byte("settings")
	keyDevice       = []byte("device")
	keyCurrent      = []byte("current")
	keyAccount      = []byte("account")
	keyKids         = []byte("kids")
	keyServer       = []byte("server")
)

var (
	ErrProfileNotFound = errors.New("store: profile not found")
	ErrInvalidItem     = errors.New("store: invalid item")
	ErrNewerSchema     = errors.New("store: database was written by a newer version of Sinag")
	ErrLocked          = errors.New("store: database is in use by another Sinag process")
)

// Store is an open database. It is safe for concurrent use.
type Store struct {
	db *bolt.DB
	// Called, outside any transaction, after a write that queued a push.
	queued atomic.Pointer[func(profileID uint64)]
	// The built-in addons each profile is offered (UseBuiltins).
	offered atomic.Pointer[[]Addon]
}

// Open opens the database at path, creating it and its directory if needed,
// and runs any pending migrations.
func Open(path string) (*Store, error) {
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return nil, err
	}
	db, err := bolt.Open(path, 0o600, &bolt.Options{Timeout: time.Second})
	if errors.Is(err, bolt.ErrTimeout) {
		return nil, ErrLocked
	}
	if err != nil {
		return nil, err
	}
	if err := migrate(db, migrations); err != nil {
		db.Close()
		return nil, err
	}
	return &Store{db: db}, nil
}

// Close closes the database.
func (s *Store) Close() error {
	return s.db.Close()
}

// profileBucket returns the bucket of profile id, or ErrProfileNotFound.
func profileBucket(tx *bolt.Tx, id uint64) (*bolt.Bucket, error) {
	b := tx.Bucket(bucketProfiles).Bucket(u64(id))
	if b == nil {
		return nil, fmt.Errorf("%w: %d", ErrProfileNotFound, id)
	}
	return b, nil
}

// view runs fn on profile id's bucket in a read transaction.
func (s *Store) view(id uint64, fn func(p *bolt.Bucket) error) error {
	return s.db.View(func(tx *bolt.Tx) error {
		p, err := profileBucket(tx, id)
		if err != nil {
			return err
		}
		return fn(p)
	})
}

// OnQueued sets fn to be called with the profile's ID after each write that
// queued a push, once it has committed, so the push loop (#30) wakes without
// polling. fn runs in the writer's goroutine and must not block or write to
// the store. Pass nil to stop.
func (s *Store) OnQueued(fn func(profileID uint64)) {
	if fn == nil {
		s.queued.Store(nil)
		return
	}
	s.queued.Store(&fn)
}

// update runs fn on profile id's bucket in a write transaction.
func (s *Store) update(id uint64, fn func(p *bolt.Bucket) error) error {
	queued := false
	err := s.db.Update(func(tx *bolt.Tx) error {
		p, err := profileBucket(tx, id)
		if err != nil {
			return err
		}
		outbox := p.Bucket(bucketOutbox)
		var before uint64
		if outbox != nil {
			before = outbox.Sequence()
		}
		if err := fn(p); err != nil {
			return err
		}
		// Every push takes the outbox's next sequence number.
		queued = outbox != nil && outbox.Sequence() != before
		return nil
	})
	if err == nil && queued {
		if fn := s.queued.Load(); fn != nil {
			(*fn)(id)
		}
	}
	return err
}

func put(b *bolt.Bucket, key []byte, v any) error {
	data, err := json.Marshal(v)
	if err != nil {
		return err
	}
	return b.Put(key, data)
}

// each decodes every value in b (in key order) and passes it to fn.
func each[T any](b *bolt.Bucket, fn func(v T)) error {
	return b.ForEach(func(_, data []byte) error {
		var v T
		if err := json.Unmarshal(data, &v); err != nil {
			return err
		}
		fn(v)
		return nil
	})
}

// eachPrefix is each for the keys in b that start with prefix.
func eachPrefix[T any](b *bolt.Bucket, prefix []byte, fn func(v T)) error {
	c := b.Cursor()
	for k, data := c.Seek(prefix); k != nil && bytes.HasPrefix(k, prefix); k, data = c.Next() {
		var v T
		if err := json.Unmarshal(data, &v); err != nil {
			return err
		}
		fn(v)
	}
	return nil
}

func u64(v uint64) []byte {
	return binary.BigEndian.AppendUint64(nil, v)
}

// joinKey joins key parts with a 0x00 separator; ids never contain one.
func joinKey(parts ...string) []byte {
	var key []byte
	for i, part := range parts {
		if i > 0 {
			key = append(key, 0)
		}
		key = append(key, part...)
	}
	return key
}
