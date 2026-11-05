package store

import (
	"bytes"
	"cmp"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	bolt "go.etcd.io/bbolt"
)

// Profile is one person's space in Sinag: their library, progress, watched
// items and addons.
type Profile struct {
	ID   uint64 `json:"id"`
	Name string `json:"name"`
	// The URL of the profile's avatar image, or "" for none (#24).
	Avatar string `json:"avatar,omitempty"`
	// The colour behind the avatar, "#rrggbb", or "" for the default.
	AvatarColor string `json:"avatarColor,omitempty"`
	// The Nuvio profile this one syncs with (Nuvio addresses profiles by index
	// 1–6), or nil for a local-only profile such as the Guest.
	NuvioIndex *int `json:"nuvioIndex,omitempty"`
	// Whether the Nuvio profile uses the primary profile's addons
	// (uses_primary_addons): its addons are then profile 1's list, read and
	// written there, and the profile's own copy here is that list (#32).
	UsesPrimaryAddons bool `json:"usesPrimaryAddons,omitempty"`
	// The Guest profile, for using Sinag without an account (#23). There is
	// at most one, it is local-only, and signing in or out leaves it as it
	// is: its data never merges into an account's (ADR-0010).
	Guest bool `json:"guest,omitempty"`
	// Whether the profile needs its PIN to switch to it (#25).
	PinEnabled bool `json:"pinEnabled,omitempty"`
	// When the PIN is locked out until after too many wrong tries, or nil.
	PinLockedUntil *time.Time `json:"pinLockedUntil,omitempty"`
	// A kids profile sees only the addons and catalogs its KidsScope allows,
	// and leaving it asks for its PIN (#26). Nuvio has no such flag, so it is
	// kept on this device, and syncing a profile from Nuvio leaves it as it
	// is.
	Kids bool `json:"kids,omitempty"`
}

var (
	ErrInvalidProfile = errors.New("store: invalid profile")
	ErrNuvioIndexUsed = errors.New("store: Nuvio profile is already linked")
	ErrGuestExists    = errors.New("store: there is already a Guest profile")
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
		profile, err = s.createProfile(tx, profile)
		return err
	})
	if err != nil {
		return Profile{}, err
	}
	return profile, nil
}

// CurrentProfile returns the profile in use: the one last set with
// SetCurrentProfile, or else the oldest one, after creating a local Guest
// profile if there are none. The profile picker (#24) sets it on a switch,
// and it is remembered across launches.
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
		current, err = s.guestProfile(tx)
		return err
	})
	if err != nil {
		return Profile{}, err
	}
	return current, nil
}

// ProfileInUse is CurrentProfile without creating a Guest profile: ok is
// false when there are no profiles at all.
func (s *Store) ProfileInUse() (current Profile, ok bool, err error) {
	err = s.db.View(func(tx *bolt.Tx) error {
		if id := tx.Bucket(bucketSettings).Get(keyCurrent); id != nil {
			if p := tx.Bucket(bucketProfiles).Bucket(id); p != nil {
				ok = true
				return json.Unmarshal(p.Get(keyProfile), &current)
			}
		}
		profiles, err := allProfiles(tx)
		if err != nil || len(profiles) == 0 {
			return err
		}
		current, ok = profiles[0], true
		return nil
	})
	return current, ok, err
}

// SwitchToGuest makes the Guest profile the one in use, creating it if there
// is none, and returns it.
func (s *Store) SwitchToGuest() (Profile, error) {
	var guest Profile
	err := s.db.Update(func(tx *bolt.Tx) error {
		var err error
		if guest, err = s.guestProfile(tx); err != nil {
			return err
		}
		return tx.Bucket(bucketSettings).Put(keyCurrent, u64(guest.ID))
	})
	if err != nil {
		return Profile{}, err
	}
	return guest, nil
}

// guestProfile returns the Guest profile, creating it if there is none.
func (s *Store) guestProfile(tx *bolt.Tx) (Profile, error) {
	profiles, err := allProfiles(tx)
	if err != nil {
		return Profile{}, err
	}
	if i := slices.IndexFunc(profiles, func(p Profile) bool { return p.Guest }); i >= 0 {
		return profiles[i], nil
	}
	return s.createProfile(tx, Profile{Name: "Guest", Guest: true})
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
// left as they are (#23). The profile with the lowest index becomes current;
// the picker (#24) then asks if there are others. It returns the linked
// profiles in index order.
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
				if nuvio[i], err = s.createProfile(tx, profile); err != nil {
					return err
				}
				continue
			}
			profile.ID = existing[linked].ID
			profile.Kids = existing[linked].Kids
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

// createProfile adds profile, offered the built-in addons (UseBuiltins).
func (s *Store) createProfile(tx *bolt.Tx, profile Profile) (Profile, error) {
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
	if err := offerBuiltins(p, s.builtins()); err != nil {
		return Profile{}, err
	}
	return profile, put(p, keyProfile, profile)
}

// UpdateProfile saves a profile's name, avatar, PIN lock and Nuvio link. It
// leaves Kids as it is: SetKids changes that.
func (s *Store) UpdateProfile(profile Profile) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		p, err := profileBucket(tx, profile.ID)
		if err != nil {
			return err
		}
		if err := validateProfile(tx, profile, profile.ID); err != nil {
			return err
		}
		var stored Profile
		if err := json.Unmarshal(p.Get(keyProfile), &stored); err != nil {
			return err
		}
		profile.Kids = stored.Kids
		return put(p, keyProfile, profile)
	})
}

// SetKids marks profile id as a kids profile, or not (#26). Marking a profile
// starts it with no addons allowed, until SetKidsScope names some. Only a
// profile linked to Nuvio can be one: it has a PIN to leave it with, and the
// Guest has none.
func (s *Store) SetKids(id uint64, kids bool) error {
	return s.update(id, func(p *bolt.Bucket) error {
		var profile Profile
		if err := json.Unmarshal(p.Get(keyProfile), &profile); err != nil {
			return err
		}
		if kids && (profile.NuvioIndex == nil || !profile.PinEnabled) {
			return fmt.Errorf("%w: %s needs a Nuvio profile with a PIN to be a kids profile", ErrInvalidProfile, profile.Name)
		}
		profile.Kids = kids
		return put(p, keyProfile, profile)
	})
}

// DeleteProfile deletes a profile and everything in it. If it was current,
// the oldest profile left becomes current.
func (s *Store) DeleteProfile(id uint64) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		err := tx.Bucket(bucketProfiles).DeleteBucket(u64(id))
		if errors.Is(err, bolt.ErrBucketNotFound) {
			return fmt.Errorf("%w: %d", ErrProfileNotFound, id)
		}
		if err != nil {
			return err
		}
		settings := tx.Bucket(bucketSettings)
		if bytes.Equal(settings.Get(keyCurrent), u64(id)) {
			return settings.Delete(keyCurrent)
		}
		return nil
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
	if profile.Guest && profile.NuvioIndex != nil {
		return fmt.Errorf("%w: the Guest profile can't be linked to Nuvio", ErrInvalidProfile)
	}
	if !profile.Guest && profile.NuvioIndex == nil {
		return nil
	}
	if profile.NuvioIndex != nil && (*profile.NuvioIndex < 1 || *profile.NuvioIndex > 6) {
		return fmt.Errorf("%w: Nuvio index %d is outside 1–6", ErrInvalidProfile, *profile.NuvioIndex)
	}
	profiles, err := allProfiles(tx)
	if err != nil {
		return err
	}
	for _, other := range profiles {
		if other.ID == self {
			continue
		}
		if profile.Guest && other.Guest {
			return fmt.Errorf("%w: profile %d", ErrGuestExists, other.ID)
		}
		if profile.NuvioIndex != nil && other.NuvioIndex != nil && *other.NuvioIndex == *profile.NuvioIndex {
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
