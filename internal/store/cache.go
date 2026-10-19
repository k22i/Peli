package store

import bolt "go.etcd.io/bbolt"

// The cache holds data Cove can fetch again, such as the frontend's persisted
// query cache. Keys are shared by all profiles; put the profile in the key
// when an entry belongs to one.

// CacheGet returns the value stored at key, or ok false.
func (s *Store) CacheGet(key string) (value []byte, ok bool, err error) {
	err = s.db.View(func(tx *bolt.Tx) error {
		if v := tx.Bucket(bucketCache).Get([]byte(key)); v != nil {
			value, ok = append([]byte(nil), v...), true
		}
		return nil
	})
	return value, ok, err
}

// CacheSet stores value at key.
func (s *Store) CacheSet(key string, value []byte) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketCache).Put([]byte(key), value)
	})
}

// CacheDelete removes key.
func (s *Store) CacheDelete(key string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketCache).Delete([]byte(key))
	})
}
