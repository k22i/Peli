package store

import (
	"encoding/binary"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	bolt "go.etcd.io/bbolt"
)

// A migration moves the database from schema version n to n+1, where n is its
// index in migrations. Append new ones; never edit or reorder shipped ones.
// Each runs in its own transaction with the version bump, so a failed
// migration leaves the file at the previous version.
type migration func(tx *bolt.Tx) error

var migrations = []migration{
	// 1: the initial layout. Per-profile buckets are created with the profile.
	func(tx *bolt.Tx) error {
		for _, name := range [][]byte{bucketProfiles, bucketCache} {
			if _, err := tx.CreateBucketIfNotExists(name); err != nil {
				return err
			}
		}
		return nil
	},
	// 2: the device's settings (#17). A profile's settings are a key in its
	// bucket, so they need no migration.
	func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(bucketSettings)
		return err
	},
	// 3: the Guest flag (#23). Until now the only local-only profile was the
	// Guest that CurrentProfile made, so the oldest one becomes the Guest.
	func(tx *bolt.Tx) error {
		profiles := tx.Bucket(bucketProfiles)
		c := profiles.Cursor()
		for id, v := c.First(); id != nil; id, v = c.Next() {
			if v != nil {
				continue
			}
			p := profiles.Bucket(id)
			var profile Profile
			if err := json.Unmarshal(p.Get(keyProfile), &profile); err != nil {
				return err
			}
			if profile.NuvioIndex == nil {
				profile.Guest = true
				return put(p, keyProfile, profile)
			}
		}
		return nil
	},
	// 4: the app was renamed from Sinag to Peli, so built-in addons moved
	// from sinag:// URLs to peli:// ones (ADR-0052). Only this device has
	// them: Nuvio's list never does.
	func(tx *bolt.Tx) error {
		profiles := tx.Bucket(bucketProfiles)
		c := profiles.Cursor()
		for id, v := c.First(); id != nil; id, v = c.Next() {
			if v != nil {
				continue
			}
			p := profiles.Bucket(id)
			addons := []Addon{}
			if err := decodeOnto(p.Get(keyAddons), &addons); err != nil {
				return err
			}
			if slices.ContainsFunc(addons, func(a Addon) bool { return isSinagURL(a.URL) }) {
				for i := range addons {
					addons[i].URL = fromSinag(addons[i].URL)
				}
				if err := put(p, keyAddons, addons); err != nil {
					return err
				}
			}
			offered := []string{}
			if err := decodeOnto(p.Get(keyBuiltinsOffered), &offered); err != nil {
				return err
			}
			if slices.ContainsFunc(offered, isSinagURL) {
				for i := range offered {
					offered[i] = fromSinag(offered[i])
				}
				if err := put(p, keyBuiltinsOffered, offered); err != nil {
					return err
				}
			}
		}
		return nil
	},
	// 5: downloads for offline viewing (#85, ADR-0064). One device-level
	// bucket, keyed by download ID, outside the profiles: a download is never
	// synced to Nuvio.
	func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(bucketDownloads)
		return err
	},
	// 6: Live TV sources (ADR-0066). One device-level bucket, keyed by source
	// ID, each record naming its profile; never synced to Nuvio.
	func(tx *bolt.Tx) error {
		_, err := tx.CreateBucketIfNotExists(bucketLiveTV)
		return err
	},
}

func isSinagURL(url string) bool { return strings.HasPrefix(strings.ToLower(url), "sinag://") }

// fromSinag returns a built-in addon's sinag:// URL as its peli:// one, and
// any other URL as it is.
func fromSinag(url string) string {
	if !isSinagURL(url) {
		return url
	}
	return "peli://" + url[len("sinag://"):]
}

func migrate(db *bolt.DB, migrations []migration) error {
	var version uint64
	err := db.Update(func(tx *bolt.Tx) error {
		meta, err := tx.CreateBucketIfNotExists(bucketMeta)
		if err != nil {
			return err
		}
		if v := meta.Get(keySchema); v != nil {
			version = binary.BigEndian.Uint64(v)
		}
		return nil
	})
	if err != nil {
		return err
	}
	if version > uint64(len(migrations)) {
		return fmt.Errorf("%w (schema %d, this build knows %d)", ErrNewerSchema, version, len(migrations))
	}

	for v := version; v < uint64(len(migrations)); v++ {
		err := db.Update(func(tx *bolt.Tx) error {
			if err := migrations[v](tx); err != nil {
				return err
			}
			return tx.Bucket(bucketMeta).Put(keySchema, u64(v+1))
		})
		if err != nil {
			return fmt.Errorf("store: migration to schema %d: %w", v+1, err)
		}
	}
	return nil
}
