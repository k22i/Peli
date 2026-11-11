package account

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/k22i/Peli/internal/nuvio"
	"github.com/k22i/Peli/internal/store"
)

// Managing profiles (#95). A Nuvio profile changes in Nuvio first and on this
// device once Nuvio has it, so nothing is queued: offline or signed out, the
// change fails with a code the frontend explains, until the sync module (#28)
// can push changes later. The Guest is local-only, so it changes here alone.
var (
	// ErrProfilesFull means the account already has nuvio.MaxProfiles.
	ErrProfilesFull = errors.New("account: every Nuvio profile is in use")
	// ErrPrimaryProfile means the change would delete the primary profile
	// (index 1): Nuvio's own apps keep it, since the others can share its
	// addons and plugins.
	ErrPrimaryProfile = errors.New("account: the primary profile can't be deleted")
	// ErrLastProfile means the change would delete the account's last profile.
	ErrLastProfile = errors.New("account: the last profile can't be deleted")
)

// maxNameLength is the longest profile name, in characters, as in Nuvio's
// account dashboard.
const maxNameLength = 80

// Avatar is one of Nuvio's stock avatars, for the profile editor.
type Avatar struct {
	ID    string `json:"id"`
	Name  string `json:"name"`
	Image string `json:"image"`
	// The colour the avatar is drawn for, "#rrggbb" or "".
	Color string `json:"color"`
}

// Avatars returns Nuvio's stock avatars. The catalog is public, so it works
// signed out, but not offline.
func (s *Service) Avatars(ctx context.Context) ([]Avatar, error) {
	catalog, err := s.nuvio.AvatarCatalog(ctx)
	if err != nil {
		return nil, err
	}
	avatars := make([]Avatar, len(catalog))
	for i, a := range catalog {
		avatars[i] = Avatar{ID: a.ID, Name: a.Name, Image: s.nuvio.AvatarImageURL(a), Color: hexColor(a.Color)}
	}
	return avatars, nil
}

// ProfileEdit is what the profile editor saves.
type ProfileEdit struct {
	Name string `json:"name"`
	// A stock avatar's ID from Avatars, or "" to keep the avatar. The Guest
	// has none.
	AvatarID string `json:"avatarId"`
	// "#rrggbb", or "" to keep the colour. The Guest's stays the brand's.
	AvatarColor string `json:"avatarColor"`
}

// EditProfile renames a profile and changes its avatar and colour, and
// returns it as saved. A Nuvio profile changes in Nuvio, on every device; the
// Guest is renamed on this device only.
func (s *Service) EditProfile(ctx context.Context, profileID uint64, edit ProfileEdit) (store.Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	db := store.Opened(s.store)
	local, err := db.Profile(profileID)
	if err != nil {
		return store.Profile{}, err
	}
	if local.PinEnabled && !s.unlocked[local.ID] {
		return store.Profile{}, ErrProfileLocked
	}
	if err := s.guardKids(db, &local); err != nil {
		return store.Profile{}, err
	}
	name, err := profileName(edit.Name)
	if err != nil {
		return store.Profile{}, err
	}
	if local.NuvioIndex == nil {
		local.Name = name
		return local, db.UpdateProfile(local)
	}

	patch := nuvio.ProfilePatch{}
	if name != local.Name {
		patch.Name = &name
	}
	if edit.AvatarColor != "" {
		color := hexColor(edit.AvatarColor)
		if color == "" {
			return store.Profile{}, fmt.Errorf("%w: colour %q isn't #rrggbb", store.ErrInvalidProfile, edit.AvatarColor)
		}
		patch.AvatarColor = &color
	}
	images, err := s.stockAvatar(ctx, edit.AvatarID)
	if err != nil {
		return store.Profile{}, err
	}
	if edit.AvatarID != "" {
		patch.AvatarID = &edit.AvatarID
	}

	var remote nuvio.Profile
	err = s.session.Do(ctx, func(session nuvio.Session) error {
		remote, err = s.nuvio.PatchProfile(ctx, session, *local.NuvioIndex, patch)
		return err
	})
	if err != nil {
		return store.Profile{}, err
	}
	saved := fromNuvio(remote, images)
	saved.ID = local.ID
	saved.Kids = local.Kids
	// A patch answers without the PIN state (#33).
	saved.PinEnabled, saved.PinLockedUntil = local.PinEnabled, local.PinLockedUntil
	if saved.Avatar == "" && edit.AvatarID == "" {
		// The catalog wasn't needed for this edit, so keep the image.
		saved.Avatar = local.Avatar
	}
	return saved, db.UpdateProfile(saved)
}

// AddProfile adds a Nuvio profile at the lowest free index and returns it.
// It fails with ErrProfilesFull when the account has every profile it can.
func (s *Service) AddProfile(ctx context.Context, edit ProfileEdit) (store.Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	db := store.Opened(s.store)
	if err := s.guardKids(db, nil); err != nil {
		return store.Profile{}, err
	}
	name, err := profileName(edit.Name)
	if err != nil {
		return store.Profile{}, err
	}
	color := hexColor(edit.AvatarColor)
	if color == "" {
		return store.Profile{}, fmt.Errorf("%w: colour %q isn't #rrggbb", store.ErrInvalidProfile, edit.AvatarColor)
	}
	images, err := s.stockAvatar(ctx, edit.AvatarID)
	if err != nil {
		return store.Profile{}, err
	}
	locals, err := db.Profiles()
	if err != nil {
		return store.Profile{}, err
	}

	var added nuvio.Profile
	err = s.session.Do(ctx, func(session nuvio.Session) error {
		// Pushed with every profile, freshly pulled: live is documented to
		// delete the ones a push leaves out (docs/spikes/nuvio-backend.md).
		remote, err := s.nuvio.Profiles(ctx, session)
		if err != nil {
			return err
		}
		index := freeIndex(remote, locals)
		if index == 0 {
			return ErrProfilesFull
		}
		added = nuvio.Profile{Index: index, Name: name, AvatarColor: color}
		if edit.AvatarID != "" {
			added.AvatarID = &edit.AvatarID
		}
		return s.nuvio.PushProfiles(ctx, session, append(remote, added))
	})
	if err != nil {
		return store.Profile{}, err
	}
	return db.CreateProfile(fromNuvio(added, images))
}

// freeIndex returns the lowest Nuvio index that neither the account nor a
// profile on this device uses, or 0 if there's none. A local profile can
// still hold an index whose profile another device deleted; its data stays
// until the sync module (#28) notices.
func freeIndex(remote []nuvio.Profile, locals []store.Profile) int {
	if len(remote) >= nuvio.MaxProfiles {
		return 0
	}
	for index := 1; index <= nuvio.MaxProfiles; index++ {
		used := slices.ContainsFunc(remote, func(p nuvio.Profile) bool { return p.Index == index }) ||
			slices.ContainsFunc(locals, func(p store.Profile) bool { return p.NuvioIndex != nil && *p.NuvioIndex == index })
		if !used {
			return index
		}
	}
	return 0
}

// DeleteProfile deletes a profile and everything in it. A Nuvio profile goes
// from Nuvio, on every device, except the primary and the last one. The
// Guest goes from this device. If the profile was current, the oldest one
// left becomes current.
func (s *Service) DeleteProfile(ctx context.Context, profileID uint64) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	db := store.Opened(s.store)
	local, err := db.Profile(profileID)
	if err != nil {
		return err
	}
	if local.PinEnabled && !s.unlocked[local.ID] {
		return ErrProfileLocked
	}
	if err := s.guardKids(db, &local); err != nil {
		return err
	}
	if local.NuvioIndex != nil {
		if *local.NuvioIndex == 1 {
			return ErrPrimaryProfile
		}
		locals, err := db.Profiles()
		if err != nil {
			return err
		}
		if slices.IndexFunc(locals, func(p store.Profile) bool { return p.NuvioIndex != nil && p.ID != profileID }) < 0 {
			return ErrLastProfile
		}
		err = s.session.Do(ctx, func(session nuvio.Session) error {
			return s.nuvio.DeleteProfile(ctx, session, *local.NuvioIndex)
		})
		if err != nil {
			return err
		}
	}
	return db.DeleteProfile(profileID)
}

// UnlockProfile checks a profile's PIN and marks it unlocked for this
// session, so it can be switched to and edited. A profile without a PIN, or
// not linked to Nuvio, unlocks without a check.
func (s *Service) UnlockProfile(ctx context.Context, profileID uint64, pin string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	p, err := store.Opened(s.store).Profile(profileID)
	if err != nil {
		return err
	}
	if err := s.verifyPIN(ctx, p, pin); err != nil {
		return err
	}
	s.unlocked[profileID] = true
	return nil
}

// verifyPIN checks pin against profile p's PIN, with Nuvio. A profile without
// a PIN, or not linked to Nuvio, passes without a check.
func (s *Service) verifyPIN(ctx context.Context, p store.Profile, pin string) error {
	if !p.PinEnabled || p.NuvioIndex == nil {
		return nil
	}
	var res nuvio.VerifyProfilePINResult
	err := s.session.Do(ctx, func(session nuvio.Session) error {
		var err error
		res, err = s.nuvio.VerifyProfilePIN(ctx, session, *p.NuvioIndex, pin)
		return err
	})
	if err != nil {
		return err
	}
	if !res.Unlocked {
		return &ErrWrongPIN{RetryAfter: res.RetryAfterSeconds}
	}
	return nil
}

// SetProfilePIN sets or changes a profile's PIN (#25). currentPin is the
// profile's existing PIN when it has one, and must match to change it.
func (s *Service) SetProfilePIN(ctx context.Context, profileID uint64, pin, currentPin string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	db := store.Opened(s.store)
	local, err := db.Profile(profileID)
	if err != nil {
		return err
	}
	if local.NuvioIndex == nil {
		return fmt.Errorf("%w: %s has no Nuvio profile", store.ErrInvalidProfile, local.Name)
	}
	if local.PinEnabled && !s.unlocked[profileID] {
		return ErrProfileLocked
	}
	if err := s.guardKids(db, &local); err != nil {
		return err
	}
	if !fourDigits(pin) {
		return ErrPINFormat
	}
	err = s.session.Do(ctx, func(session nuvio.Session) error {
		return s.nuvio.SetProfilePIN(ctx, session, *local.NuvioIndex, pin, currentPin)
	})
	if err != nil {
		if currentPINRequired(err) {
			return &ErrWrongPIN{RetryAfter: 0}
		}
		if pinFormatErr(err) {
			return ErrPINFormat
		}
		return err
	}
	local.PinEnabled = true
	local.PinLockedUntil = nil
	s.unlocked[profileID] = true
	return db.UpdateProfile(local)
}

// ClearProfilePIN removes a profile's PIN (#25). currentPin is the profile's
// existing PIN and must match to remove it.
func (s *Service) ClearProfilePIN(ctx context.Context, profileID uint64, currentPin string) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	db := store.Opened(s.store)
	local, err := db.Profile(profileID)
	if err != nil {
		return err
	}
	if local.NuvioIndex == nil {
		return fmt.Errorf("%w: %s has no Nuvio profile", store.ErrInvalidProfile, local.Name)
	}
	if local.PinEnabled && !s.unlocked[profileID] {
		return ErrProfileLocked
	}
	if err := s.guardKids(db, &local); err != nil {
		return err
	}
	if local.Kids {
		return ErrKidsKeepsPIN
	}
	err = s.session.Do(ctx, func(session nuvio.Session) error {
		return s.nuvio.ClearProfilePIN(ctx, session, *local.NuvioIndex, currentPin)
	})
	if err != nil {
		if currentPINRequired(err) {
			return &ErrWrongPIN{RetryAfter: 0}
		}
		return err
	}
	local.PinEnabled = false
	local.PinLockedUntil = nil
	return db.UpdateProfile(local)
}

// SwitchProfile makes a profile current. A profile with a PIN needs
// UnlockProfile first, and leaving a kids profile needs ApproveParent (#26).
// Switching to a kids profile locks it again: its parent PIN is needed anew
// to leave.
func (s *Service) SwitchProfile(ctx context.Context, profileID uint64) (store.Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	db := store.Opened(s.store)
	p, err := db.Profile(profileID)
	if err != nil {
		return store.Profile{}, err
	}
	if p.PinEnabled && !s.unlocked[profileID] {
		return store.Profile{}, ErrProfileLocked
	}
	current, _, err := db.ProfileInUse()
	if err != nil {
		return store.Profile{}, err
	}
	if current.ID == profileID {
		return p, nil
	}
	if current.Kids && !s.parentApproved(current.ID) {
		return store.Profile{}, ErrParentPINRequired
	}
	if err := db.SetCurrentProfile(profileID); err != nil {
		return store.Profile{}, err
	}
	clear(s.parent)
	return p, nil
}

// stockAvatar checks that id is in the catalog, since Nuvio refuses an
// unknown one with the same code as a missing session, and returns every
// stock avatar's image. An empty id needs no catalog.
func (s *Service) stockAvatar(ctx context.Context, id string) (map[string]string, error) {
	if id == "" {
		return nil, nil
	}
	catalog, err := s.nuvio.AvatarCatalog(ctx)
	if err != nil {
		return nil, err
	}
	images := make(map[string]string, len(catalog))
	for _, a := range catalog {
		images[a.ID] = s.nuvio.AvatarImageURL(a)
	}
	if images[id] == "" {
		return nil, fmt.Errorf("%w: avatar %q isn't in Nuvio's catalog", store.ErrInvalidProfile, id)
	}
	return images, nil
}

// profileName trims a profile's name and checks it.
func profileName(name string) (string, error) {
	name = strings.TrimSpace(name)
	switch {
	case name == "":
		return "", fmt.Errorf("%w: name is empty", store.ErrInvalidProfile)
	case utf8.RuneCountInString(name) > maxNameLength:
		return "", fmt.Errorf("%w: name is over %d characters", store.ErrInvalidProfile, maxNameLength)
	}
	return name, nil
}

// fromNuvio returns a Nuvio profile as it's kept on this device, with its
// avatar from images, a stock avatar's image by ID.
func fromNuvio(p nuvio.Profile, images map[string]string) store.Profile {
	return store.Profile{
		Name:               p.Name,
		NuvioIndex:         &p.Index,
		UsesPrimaryAddons:  p.UsesPrimaryAddons && p.Index != 1,
		UsesPrimaryPlugins: p.UsesPrimaryPlugins && p.Index != 1,
		Avatar:             avatarImage(p, images),
		AvatarColor:        hexColor(p.AvatarColor),
		PinEnabled:         p.PinEnabled,
		PinLockedUntil:     p.PinLockedUntil,
	}
}

// RefreshProfiles brings this device's Nuvio profiles in line with the
// account's: a profile deleted, added or renamed on another device, or
// a PIN set or removed there (on nuvio.tv, say), shows here at the next sync,
// not only at the next sign-in. The syncer calls it before each pull; it does
// nothing without Nuvio profiles or a session, and an error leaves the
// profiles as they were. A profile in use that gains a PIN stays unlocked for
// this run: the user is already in it.
func (s *Service) RefreshProfiles(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	db := store.Opened(s.store)
	if db == nil {
		return nil
	}
	if linked, err := db.HasNuvioProfiles(); err != nil || !linked {
		return err
	}
	var remote []nuvio.Profile
	var locks []nuvio.ProfileLock
	var account string
	err := s.session.Do(ctx, func(session nuvio.Session) error {
		var err error
		if remote, err = s.nuvio.Profiles(ctx, session); err != nil {
			return err
		}
		// The locks are the authoritative PIN state; the profiles carry it too.
		locks, _ = s.nuvio.ProfileLocks(ctx, session)
		account = session.UserID
		return nil
	})
	if err != nil {
		return err
	}
	if s.avatars == nil {
		s.avatars = s.avatarImages(ctx)
	}
	profiles := make([]store.Profile, len(remote))
	for i, p := range remote {
		profiles[i] = fromNuvio(p, s.avatars)
		for _, lock := range locks {
			if lock.Index == p.Index {
				profiles[i].PinEnabled, profiles[i].PinLockedUntil = lock.PinEnabled, lock.PinLockedUntil
			}
		}
	}
	before, _, _ := db.ProfileInUse()
	changed, gone, err := db.SyncNuvioProfiles(account, profiles)
	if err != nil || !changed {
		return err
	}
	current, err := db.CurrentProfile()
	if err != nil {
		return err
	}
	if !gone && current.ID == before.ID && current.PinEnabled && !before.PinEnabled {
		s.unlocked[current.ID] = true
	}
	if s.emitProfiles != nil {
		s.emitProfiles(ProfilesChanged{Current: current, CurrentGone: gone})
	}
	return nil
}

// ProfileRefresher returns service's RefreshProfiles, for the syncer to call
// before each pull. It isn't a method, so Wails doesn't bind it.
func ProfileRefresher(service *Service) func(context.Context) error {
	return service.RefreshProfiles
}
