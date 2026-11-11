package account

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/k22i/Peli/internal/store"
)

// Kids profiles (#26). A kids profile sees only what its parent allowed
// (store.KidsScope) and can only be left, or changed, with its PIN. The PIN
// is the profile's own Nuvio PIN: whoever sets a kids profile up chooses it,
// and it is the parent PIN. Nuvio has no kids flag, so the flag stays on this
// device.
//
// Unlocking a profile (UnlockProfile) lets it be entered. Leaving a kids
// profile, or changing anything about the account or its profiles while one
// is in use, needs ApproveParent instead: the PIN again, good for parentWindow
// or until the next switch, whichever is first.
var (
	// ErrParentPINRequired means a kids profile is in use, or is the one
	// being changed, and the parent PIN hasn't been entered lately.
	ErrParentPINRequired = errors.New("account: the parent PIN is needed")
	// ErrKidsNeedsPIN means the profile can't be a kids profile: it has no
	// PIN to leave it with, or isn't a Nuvio profile.
	ErrKidsNeedsPIN = errors.New("account: a kids profile needs a Nuvio profile with a PIN")
	// ErrKidsKeepsPIN means the change would remove the PIN of a kids
	// profile, which is what guards it.
	ErrKidsKeepsPIN = errors.New("account: a kids profile keeps its PIN")
)

// parentWindow is how long the parent PIN keeps working after it was entered.
// It is long enough to change a few things, and short enough that handing the
// app back doesn't leave the kids profile open.
const parentWindow = 2 * time.Minute

// parentApproved reports whether the parent PIN of kids profile id was
// entered within parentWindow and no switch has happened since.
func (s *Service) parentApproved(id uint64) bool {
	until, ok := s.parent[id]
	return ok && s.now().Before(until)
}

// guardKids returns ErrParentPINRequired if the profile in use is a kids
// profile, or target is one, and its parent PIN isn't approved. Nothing may
// leave or change a kids profile without it. Callers hold s.mu.
func (s *Service) guardKids(db *store.Store, target *store.Profile) error {
	current, _, err := db.ProfileInUse()
	if err != nil {
		return err
	}
	if current.Kids && !s.parentApproved(current.ID) {
		return ErrParentPINRequired
	}
	if target != nil && target.Kids && !s.parentApproved(target.ID) {
		return ErrParentPINRequired
	}
	return nil
}

// ApproveParent checks a kids profile's PIN, the parent PIN, and approves
// changes and leaving for parentWindow. It also unlocks the profile, like
// UnlockProfile. A kids profile whose PIN was since removed on another device
// approves without a check, as UnlockProfile does: the parent can still turn
// kids mode off, and set a PIN again.
func (s *Service) ApproveParent(ctx context.Context, profileID uint64, pin string) error {
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
	if p.Kids {
		s.parent[profileID] = s.now().Add(parentWindow)
	}
	return nil
}

// SetKids makes a profile a kids profile, or an ordinary one again. A kids
// profile starts with nothing allowed: choose what it sees with
// SetKidsScope. It needs a Nuvio profile with a PIN, which becomes the parent
// PIN. Turning it on locks the profile at once, so the parent PIN is needed
// to leave it. It returns the profile as saved.
func (s *Service) SetKids(ctx context.Context, profileID uint64, kids bool) (store.Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	db := store.Opened(s.store)
	local, err := db.Profile(profileID)
	if err != nil {
		return store.Profile{}, err
	}
	if local.PinEnabled && !s.unlocked[profileID] {
		return store.Profile{}, ErrProfileLocked
	}
	if err := s.guardKids(db, &local); err != nil {
		return store.Profile{}, err
	}
	if kids && (local.NuvioIndex == nil || !local.PinEnabled) {
		return store.Profile{}, ErrKidsNeedsPIN
	}
	if err := db.SetKids(profileID, kids); err != nil {
		return store.Profile{}, err
	}
	delete(s.parent, profileID)
	local.Kids = kids
	return local, nil
}

// SetKidsScope chooses the addons and catalogs a kids profile may see.
func (s *Service) SetKidsScope(ctx context.Context, profileID uint64, scope store.KidsScope) error {
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
	if !local.Kids {
		return fmt.Errorf("%w: %s isn't a kids profile", store.ErrInvalidProfile, local.Name)
	}
	return db.SetKidsScope(profileID, scope)
}
