package account

import (
	"context"

	"github.com/k22i/Sinag/internal/store"
)

// Installing, reconfiguring, removing, reordering and turning addons on or off, for the addon
// manager (#38). Each is one edit of the stored list, so the manager never
// writes back a list it read earlier; the push loop sends the new list to
// Nuvio, merged with what other devices changed (#32, ADR-0019). They are
// here rather than in the store service because a kids profile's addons, or
// any while one is in use, change only with the parent PIN (#26).

// InstallAddon adds an addon at the end of a profile's list.
func (s *Service) InstallAddon(ctx context.Context, profileID uint64, addon store.Addon) error {
	return s.editAddons(profileID, func(db *store.Store) error { return db.InstallAddon(profileID, addon) })
}

// InsertAddon adds an addon at position at (from 0) in a profile's list: the
// manager's undo of a removal.
func (s *Service) InsertAddon(ctx context.Context, profileID uint64, addon store.Addon, at int) error {
	return s.editAddons(profileID, func(db *store.Store) error { return db.InsertAddon(profileID, addon, at) })
}

// ReconfigureAddon puts addon, with its new manifest URL from the addon's
// configure page, in the place of the addon at manifest URL url.
func (s *Service) ReconfigureAddon(ctx context.Context, profileID uint64, url string, addon store.Addon) error {
	return s.editAddons(profileID, func(db *store.Store) error { return db.ReplaceAddon(profileID, url, addon) })
}

// RemoveAddon removes the addon at manifest URL url from a profile's list.
func (s *Service) RemoveAddon(ctx context.Context, profileID uint64, url string) error {
	return s.editAddons(profileID, func(db *store.Store) error { return db.RemoveAddon(profileID, url) })
}

// MoveAddon moves the addon at manifest URL url to position to (from 0) in a
// profile's list.
func (s *Service) MoveAddon(ctx context.Context, profileID uint64, url string, to int) error {
	return s.editAddons(profileID, func(db *store.Store) error { return db.MoveAddon(profileID, url, to) })
}

// EnableAddon turns the addon at manifest URL url on or off.
func (s *Service) EnableAddon(ctx context.Context, profileID uint64, url string, enabled bool) error {
	return s.editAddons(profileID, func(db *store.Store) error { return db.EnableAddon(profileID, url, enabled) })
}

// editAddons runs edit if the profile may be changed: unlocked, and with the
// parent PIN approved if it, or the profile in use, is a kids profile. The
// home layout's edits use it too (home.go).
func (s *Service) editAddons(profileID uint64, edit func(db *store.Store) error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	db := store.Opened(s.store)
	local, err := db.Profile(profileID)
	if err != nil {
		return err
	}
	if local.PinEnabled && !s.unlocked[profileID] {
		return ErrProfileLocked
	}
	if err := s.guardKids(db, &local); err != nil {
		return err
	}
	return edit(db)
}

// EditorOf returns service's guarded way to change a profile's data, for the
// plugin service (#57, internal/plugins): the same check the addon edits make.
// It isn't a method, so Wails doesn't bind it.
func EditorOf(service *Service) func(profileID uint64, edit func(db *store.Store) error) error {
	return service.editAddons
}
