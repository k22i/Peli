package account

import (
	"context"
	"errors"
	"fmt"
	"slices"
	"strings"
	"unicode/utf8"

	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/store"
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
		Name:        p.Name,
		NuvioIndex:  &p.Index,
		Avatar:      avatarImage(p, images),
		AvatarColor: hexColor(p.AvatarColor),
	}
}
