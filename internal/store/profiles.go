package store

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
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
		var err error
		profile, err = createProfile(tx, profile)
		return err
	})
	if err != nil {
		return Profile{}, err
	}
	return profile, nil
}

// CurrentProfile returns the profile in use: the one last set with
// SetCurrentProfile, or else the oldest one, after creating a local Guest
// profile if there are none. The profile picker (#24) sets it on a switch.
func (s *Store) CurrentProfile() (Profile, error) {
	var current Profile
	err := s.db.Update(func(tx *bolt.Tx) error {
		if id := tx.Bucket(bucketSettings).Get(keyCurrent); id != nil {
			if p := tx.Bucket(bucketProfiles).Bucket(id); p != nil {
				return json.Unmarshal(p.Get(keyProfile), &current)
			}
		}
		profiles, err := allProfiles(tx)
		if err != nil {
			return err
		}
		if len(profiles) > 0 {
			current = profiles[0]
			return nil
		}
		current, err = createProfile(tx, Profile{Name: "Guest"})
		return err
	})
	if err != nil {
		return Profile{}, err
	}
	return current, nil
}

// SetCurrentProfile makes profile id the one in use.
func (s *Store) SetCurrentProfile(id uint64) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		if _, err := profileBucket(tx, id); err != nil {
			return err
		}
		return tx.Bucket(bucketSettings).Put(keyCurrent, u64(id))
	})
}

// LinkNuvioProfiles saves the Nuvio profiles of account (its user id) after
// signing in: each updates the local profile linked to its index, or becomes
// a new one. If another account's profiles are linked, they are removed
// first, so one account's data never merges into another's; an account of ""
// is unknown and removes nothing. Local-only profiles, such as a guest's, are
// left as they are (#23). The profile with the lowest index becomes current,
// until the picker (#24) asks. It returns the linked profiles in index order.
func (s *Store) LinkNuvioProfiles(account string, nuvio []Profile) ([]Profile, error) {
	for _, profile := range nuvio {
		if profile.NuvioIndex == nil {
			return nil, fmt.Errorf("%w: %q has no Nuvio index", ErrInvalidProfile, profile.Name)
		}
	}
	nuvio = slices.Clone(nuvio)
	slices.SortFunc(nuvio, func(a, b Profile) int { return cmp.Compare(*a.NuvioIndex, *b.NuvioIndex) })
	err := s.db.Update(func(tx *bolt.Tx) error {
		settings := tx.Bucket(bucketSettings)
		if account != "" {
			if linked := settings.Get(keyAccount); linked != nil && string(linked) != account {
				if err := removeNuvioProfiles(tx); err != nil {
					return err
				}
			}
			if err := settings.Put(keyAccount, []byte(account)); err != nil {
				return err
			}
		}
		existing, err := allProfiles(tx)
		if err != nil {
			return err
		}
		for i, profile := range nuvio {
			linked := slices.IndexFunc(existing, func(p Profile) bool {
				return p.NuvioIndex != nil && *p.NuvioIndex == *profile.NuvioIndex
			})
			if linked < 0 {
				if nuvio[i], err = createProfile(tx, profile); err != nil {
					return err
				}
				continue
			}
			profile.ID = existing[linked].ID
			if err := validateProfile(tx, profile, profile.ID); err != nil {
				return err
			}
			if err := put(tx.Bucket(bucketProfiles).Bucket(u64(profile.ID)), keyProfile, profile); err != nil {
				return err
			}
			nuvio[i] = profile
		}
		if len(nuvio) == 0 {
			return nil
		}
		return settings.Put(keyCurrent, u64(nuvio[0].ID))
	})
	if err != nil {
		return nil, err
	}
	return nuvio, nil
}

// RemoveNuvioProfiles deletes every profile linked to Nuvio and everything
// in it, after signing out: Nuvio has the account's data, and signing in
// again pulls it back. Local-only profiles stay.
func (s *Store) RemoveNuvioProfiles() error {
	return s.db.Update(removeNuvioProfiles)
}

// HasNuvioProfiles reports whether any profile is linked to Nuvio.
func (s *Store) HasNuvioProfiles() (bool, error) {
	profiles, err := s.Profiles()
	return slices.ContainsFunc(profiles, func(p Profile) bool { return p.NuvioIndex != nil }), err
}

func removeNuvioProfiles(tx *bolt.Tx) error {
	profiles, err := allProfiles(tx)
	if err != nil {
		return err
	}
	settings := tx.Bucket(bucketSettings)
	current := settings.Get(keyCurrent)
	for _, profile := range profiles {
		if profile.NuvioIndex == nil {
			continue
		}
		if err := tx.Bucket(bucketProfiles).DeleteBucket(u64(profile.ID)); err != nil {
			return err
		}
		if bytes.Equal(current, u64(profile.ID)) {
			if err := settings.Delete(keyCurrent); err != nil {
				return err
			}
		}
	}
	return settings.Delete(keyAccount)
}

func createProfile(tx *bolt.Tx, profile Profile) (Profile, error) {
	if err := validateProfile(tx, profile, 0); err != nil {
		return Profile{}, err
	}
	profiles := tx.Bucket(bucketProfiles)
	id, err := profiles.NextSequence()
	if err != nil {
		return Profile{}, err
	}
	profile.ID = id
	p, err := profiles.CreateBucket(u64(id))
	if err != nil {
		return Profile{}, err
	}
	for _, name := range [][]byte{bucketLibrary, bucketProgress, bucketWatched, bucketCursors, bucketOutbox} {
		if _, err := p.CreateBucket(name); err != nil {
			return Profile{}, err
		}
	}
	return profile, put(p, keyProfile, profile)
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
