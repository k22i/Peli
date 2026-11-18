package tracking

import (
	"context"
	"errors"
	"slices"

	"github.com/k22i/Peli/internal/secrets"
	"github.com/k22i/Peli/internal/store"
)

// Device pairing (#133, ADR-0061) copies a profile's grants to another
// device. These are package functions, not methods, so Wails doesn't bind
// them: a token never reaches the webview.

// Grants are one profile's tokens, as pairing carries them.
type Grants struct {
	Simkl   *SimklGrant   `json:"simkl,omitempty"`
	AniList *AniListGrant `json:"anilist,omitempty"`
}

// SimklGrant is a SIMKL access and refresh token. Refresh hands back the same
// refresh token, so two devices can hold one grant.
type SimklGrant struct {
	Access  string `json:"access"`
	Refresh string `json:"refresh"`
	// When the access token expires, Unix ms.
	ExpiresAt int64  `json:"expiresAt"`
	User      string `json:"user"`
}

// AniListGrant is an AniList token (a year long, no refresh, no revoke).
type AniListGrant struct {
	Token string `json:"token"`
	// When it expires, Unix ms; 0 for unknown.
	ExpiresAt int64  `json:"expiresAt"`
	UserID    int    `json:"userId"`
	User      string `json:"user"`
}

// Empty reports whether there's nothing to copy.
func (g Grants) Empty() bool { return g.Simkl == nil && g.AniList == nil }

// Export returns profile id's working grants: a connection that needs
// connecting again is left out, and a SIMKL token due for a refresh is
// refreshed first, so the other device starts with a fresh one. Kids
// profiles have none to give.
func Export(ctx context.Context, s *Service, profileID uint64) (Grants, error) {
	if err := s.canConnect(profileID); err != nil {
		return Grants{}, err
	}
	t, err := s.open().Tracking(profileID)
	if err != nil {
		return Grants{}, err
	}
	var g Grants
	if l := t.Simkl; l != nil && !l.NeedsReconnect {
		access, err := s.simklToken(ctx, profileID)
		switch {
		case errors.Is(err, ErrNotConnected):
		case err != nil:
			return Grants{}, err
		default:
			refresh, err := s.keychain.Get(simklRefreshKey(profileID))
			if err != nil && !errors.Is(err, secrets.ErrNotFound) {
				return Grants{}, err
			}
			if err == nil {
				// The refresh may have moved the expiry on.
				if fresh, err := s.open().Tracking(profileID); err == nil && fresh.Simkl != nil {
					l = fresh.Simkl
				}
				g.Simkl = &SimklGrant{Access: access, Refresh: refresh, ExpiresAt: l.AccessExpires, User: l.User}
			}
		}
	}
	if l := t.AniList; l != nil && !l.NeedsReconnect && (l.Expires == 0 || s.now().UnixMilli() < l.Expires) {
		token, err := s.keychain.Get(anilistKey(profileID))
		if err != nil && !errors.Is(err, secrets.ErrNotFound) {
			return Grants{}, err
		}
		if err == nil {
			g.AniList = &AniListGrant{Token: token, ExpiresAt: l.Expires, UserID: l.UserID, User: l.User}
		}
	}
	return g, nil
}

// Adopt keeps grants from the device named from for profile id, as a
// sign-in would, marked shared with that device, then imports in the
// background. A connection the profile already had is replaced (not
// revoked: it may be the other device's own); its queued jobs go if the
// account differs.
func Adopt(s *Service, profileID uint64, g Grants, from string) error {
	if err := s.canConnect(profileID); err != nil {
		return err
	}
	db := s.open()
	before, err := db.Tracking(profileID)
	if err != nil {
		return err
	}
	if g.Simkl != nil {
		if g.Simkl.Access == "" || g.Simkl.Refresh == "" {
			return errors.New("tracking: the SIMKL grant has no token")
		}
		if err := db.SetTrackingTokenOwner(profileID, true); err != nil {
			return err
		}
		if err := s.keychain.Set(simklAccessKey(profileID), g.Simkl.Access); err != nil {
			return err
		}
		if err := s.keychain.Set(simklRefreshKey(profileID), g.Simkl.Refresh); err != nil {
			return err
		}
		if before.Simkl != nil && before.Simkl.User != g.Simkl.User {
			_ = db.DropTrackingJobs(profileID, ServiceSimkl)
		}
	}
	if g.AniList != nil {
		if g.AniList.Token == "" {
			return errors.New("tracking: the AniList grant has no token")
		}
		if err := db.SetTrackingTokenOwner(profileID, true); err != nil {
			return err
		}
		if err := s.keychain.Set(anilistKey(profileID), g.AniList.Token); err != nil {
			return err
		}
		if before.AniList != nil && before.AniList.UserID != g.AniList.UserID {
			_ = db.DropTrackingJobs(profileID, ServiceAniList)
		}
	}
	err = db.UpdateTracking(profileID, func(t *store.Tracking) error {
		if g.Simkl != nil {
			t.Simkl = &store.SimklLink{User: g.Simkl.User, AccessExpires: g.Simkl.ExpiresAt, Shared: shareWith(nil, from)}
		}
		if g.AniList != nil {
			t.AniList = &store.AniListLink{UserID: g.AniList.UserID, User: g.AniList.User, Expires: g.AniList.ExpiresAt, Shared: shareWith(nil, from)}
		}
		return nil
	})
	if err != nil {
		return err
	}
	if !g.Empty() {
		s.connected(profileID)
		s.emit(EventChanged, profileID)
	}
	return nil
}

// MarkShared notes that profile id's grants in g were sent to the device
// named to, so Disconnect asks whether to revoke them everywhere.
func MarkShared(s *Service, profileID uint64, g Grants, to string) error {
	err := s.open().UpdateTracking(profileID, func(t *store.Tracking) error {
		if g.Simkl != nil && t.Simkl != nil {
			t.Simkl.Shared = shareWith(t.Simkl.Shared, to)
		}
		if g.AniList != nil && t.AniList != nil {
			t.AniList.Shared = shareWith(t.AniList.Shared, to)
		}
		return nil
	})
	if err == nil {
		s.emit(EventChanged, profileID)
	}
	return err
}

func shareWith(names []string, device string) []string {
	if device == "" {
		device = "another device"
	}
	if slices.Contains(names, device) {
		return names
	}
	return append(slices.Clone(names), device)
}

// ForgetSimkl removes profile id's SIMKL tokens, connection and queued
// scrobbles from this device without revoking the grant, so the devices it
// was shared with stay connected ("On this device only").
func (s *Service) ForgetSimkl(profileID uint64) (Connections, error) {
	return s.disconnect(profileID, ServiceSimkl)
}
