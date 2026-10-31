package tracking

import (
	"context"
	"errors"
	"time"

	"github.com/k22i/Sinag/internal/anilist"
	"github.com/k22i/Sinag/internal/secrets"
	"github.com/k22i/Sinag/internal/simkl"
	"github.com/k22i/Sinag/internal/store"
)

// refreshBefore is how long before it expires a SIMKL access token is
// refreshed (they last a week).
const refreshBefore = 24 * time.Hour

// simklToken returns profile id's SIMKL access token, refreshed first if
// it's due. ErrNotConnected means there's none, or it needs connecting
// again.
func (s *Service) simklToken(ctx context.Context, profileID uint64) (string, error) {
	db := s.open()
	if db == nil {
		return "", ErrNotConnected
	}
	t, err := db.Tracking(profileID)
	if err != nil {
		return "", err
	}
	if t.Simkl == nil || t.Simkl.NeedsReconnect {
		return "", ErrNotConnected
	}
	if s.now().Add(refreshBefore).UnixMilli() >= t.Simkl.AccessExpires {
		return s.refreshSimkl(ctx, profileID, "")
	}
	token, err := s.keychain.Get(simklAccessKey(profileID))
	if errors.Is(err, secrets.ErrNotFound) {
		return "", ErrNotConnected
	}
	return token, err
}

// refreshSimkl gets a new access token for profile id. Sinag is the grant's
// one owner, and refreshes one at a time: two refreshes would cut each
// other's token off. stale is the token a call was refused with; if another
// refresh replaced it meanwhile, that one is used.
func (s *Service) refreshSimkl(ctx context.Context, profileID uint64, stale string) (string, error) {
	s.refreshMu.Lock()
	defer s.refreshMu.Unlock()
	if stale != "" {
		if current, err := s.keychain.Get(simklAccessKey(profileID)); err == nil && current != stale {
			return current, nil
		}
	}
	refresh, err := s.keychain.Get(simklRefreshKey(profileID))
	if errors.Is(err, secrets.ErrNotFound) {
		s.needsReconnect(profileID, ServiceSimkl)
		return "", ErrNotConnected
	}
	if err != nil {
		return "", err
	}
	token, err := s.simkl.Refresh(ctx, refresh)
	if errors.Is(err, simkl.ErrUnauthorized) {
		s.needsReconnect(profileID, ServiceSimkl)
		return "", ErrNotConnected
	}
	if err != nil {
		return "", err
	}
	if token.RefreshToken == "" {
		token.RefreshToken = refresh
	}
	if err := s.saveSimklTokens(profileID, token); err != nil {
		return "", err
	}
	err = s.open().UpdateTracking(profileID, func(t *store.Tracking) error {
		if t.Simkl != nil {
			t.Simkl.AccessExpires = s.expiry(token)
		}
		return nil
	})
	return token.AccessToken, err
}

// withSimkl calls fn with profile id's token, refreshing it and calling
// again once if SIMKL refuses it.
func (s *Service) withSimkl(ctx context.Context, profileID uint64, fn func(token string) error) error {
	token, err := s.simklToken(ctx, profileID)
	if err != nil {
		return err
	}
	err = fn(token)
	if !errors.Is(err, simkl.ErrUnauthorized) {
		return err
	}
	if token, err = s.refreshSimkl(ctx, profileID, token); err != nil {
		return err
	}
	err = fn(token)
	if errors.Is(err, simkl.ErrUnauthorized) {
		s.needsReconnect(profileID, ServiceSimkl)
		return ErrNotConnected
	}
	return err
}

// withAniList calls fn with profile id's AniList token. A refused token
// can't be refreshed: the connection needs connecting again.
func (s *Service) withAniList(ctx context.Context, profileID uint64, fn func(link store.AniListLink, token string) error) error {
	db := s.open()
	if db == nil {
		return ErrNotConnected
	}
	t, err := db.Tracking(profileID)
	if err != nil {
		return err
	}
	l := t.AniList
	if l == nil || l.NeedsReconnect || (l.Expires > 0 && s.now().UnixMilli() >= l.Expires) {
		return ErrNotConnected
	}
	token, err := s.keychain.Get(anilistKey(profileID))
	if errors.Is(err, secrets.ErrNotFound) {
		return ErrNotConnected
	}
	if err != nil {
		return err
	}
	err = fn(*l, token)
	if errors.Is(err, anilist.ErrUnauthorized) {
		s.needsReconnect(profileID, ServiceAniList)
		return ErrNotConnected
	}
	return err
}

// needsReconnect marks profile id's connection as needing a new sign-in,
// and tells Settings.
func (s *Service) needsReconnect(profileID uint64, service string) {
	err := s.open().UpdateTracking(profileID, func(t *store.Tracking) error {
		switch {
		case service == ServiceSimkl && t.Simkl != nil:
			t.Simkl.NeedsReconnect = true
		case service == ServiceAniList && t.AniList != nil:
			t.AniList.NeedsReconnect = true
		}
		return nil
	})
	if err == nil {
		s.emit(EventChanged, profileID)
	}
}
