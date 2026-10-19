package store

import (
	"encoding/binary"
	"fmt"

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
