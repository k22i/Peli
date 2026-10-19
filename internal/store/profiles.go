package store

import (
	"encoding/json"
	"errors"
	"fmt"
	"strings"

	bolt "go.etcd.io/bbolt"
)

// Profile is one person's space in Sinag: their library, progress, watched
// items and addons.
type Profile struct {
	ID     uint64 `json:"id"`
	Name   string `json:"name"`
	Avatar string `json:"avatar,omitempty"`
	// The Nuvio profile this one syncs with (Nuvio addresses profiles by index
	// 1–6), or nil for a local-only profile such as a guest's (#23).
	NuvioIndex *int `json:"nuvioIndex,omitempty"`
}

var (
	ErrInvalidProfile = errors.New("store: invalid profile")
	ErrNuvioIndexUsed = errors.New("store: Nuvio profile is already linked")
)

// Profiles returns every profile, oldest first.
func (s *Store) Profiles() ([]Profile, error) {
	profiles := []Profile{}
	err := s.db.View(func(tx *bolt.Tx) error {
		var err error
		profiles, err = allProfiles(tx)
		return err
	})
	return profiles, err
}

// Profile returns profile id.
func (s *Store) Profile(id uint64) (Profile, error) {
	var profile Profile
	err := s.view(id, func(p *bolt.Bucket) error {
		return json.Unmarshal(p.Get(keyProfile), &profile)
	})
	return profile, err
}

// CreateProfile adds a profile and returns it with its new ID.
func (s *Store) CreateProfile(profile Profile) (Profile, error) {
	err := s.db.Update(func(tx *bolt.Tx) error {
		if err := validateProfile(tx, profile, 0); err != nil {
			return err
		}
		profiles := tx.Bucket(bucketProfiles)
		id, err := profiles.NextSequence()
		if err != nil {
			return err
		}
		profile.ID = id
		p, err := profiles.CreateBucket(u64(id))
		if err != nil {
			return err
		}
		for _, name := range [][]byte{bucketLibrary, bucketProgress, bucketWatched, bucketCursors, bucketOutbox} {
			if _, err := p.CreateBucket(name); err != nil {
				return err
			}
		}
		return put(p, keyProfile, profile)
	})
	if err != nil {
		return Profile{}, err
	}
	return profile, nil
}

// UpdateProfile saves a profile's name, avatar and Nuvio link.
func (s *Store) UpdateProfile(profile Profile) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		p, err := profileBucket(tx, profile.ID)
		if err != nil {
			return err
		}
		if err := validateProfile(tx, profile, profile.ID); err != nil {
			return err
		}
		return put(p, keyProfile, profile)
	})
}

// DeleteProfile deletes a profile and everything in it.
func (s *Store) DeleteProfile(id uint64) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		err := tx.Bucket(bucketProfiles).DeleteBucket(u64(id))
		if errors.Is(err, bolt.ErrBucketNotFound) {
			return fmt.Errorf("%w: %d", ErrProfileNotFound, id)
		}
		return err
	})
}

func allProfiles(tx *bolt.Tx) ([]Profile, error) {
	profiles := []Profile{}
	err := tx.Bucket(bucketProfiles).ForEachBucket(func(id []byte) error {
		var profile Profile
		if err := json.Unmarshal(tx.Bucket(bucketProfiles).Bucket(id).Get(keyProfile), &profile); err != nil {
			return err
		}
		profiles = append(profiles, profile)
		return nil
	})
	return profiles, err
}

// validateProfile checks profile before it is saved; self is its own ID when
// it already exists.
func validateProfile(tx *bolt.Tx, profile Profile, self uint64) error {
	if strings.TrimSpace(profile.Name) == "" {
		return fmt.Errorf("%w: name is empty", ErrInvalidProfile)
	}
	if profile.NuvioIndex == nil {
		return nil
	}
	if *profile.NuvioIndex < 1 || *profile.NuvioIndex > 6 {
		return fmt.Errorf("%w: Nuvio index %d is outside 1–6", ErrInvalidProfile, *profile.NuvioIndex)
	}
	profiles, err := allProfiles(tx)
	if err != nil {
		return err
	}
	for _, other := range profiles {
		if other.ID != self && other.NuvioIndex != nil && *other.NuvioIndex == *profile.NuvioIndex {
			return fmt.Errorf("%w: index %d is linked to profile %d", ErrNuvioIndexUsed, *profile.NuvioIndex, other.ID)
		}
	}
	return nil
}

// syncs reports whether profile bucket p is linked to Nuvio, so its writes
// must be queued for push.
func syncs(p *bolt.Bucket) (bool, error) {
	var profile Profile
	if err := json.Unmarshal(p.Get(keyProfile), &profile); err != nil {
		return false, err
	}
	return profile.NuvioIndex != nil, nil
}
