package account

import (
	"context"
	"errors"
	"log/slog"
	"sync"
	"time"

	"github.com/k22i/Peli/internal/backend"
	"github.com/k22i/Peli/internal/nuvio"
	"github.com/k22i/Peli/internal/secrets"
)

// Refresh timing. A session is refreshed at launch, which is the only way to
// learn it was revoked (access tokens are checked by signature alone until
// they expire, 7 days on live), and then halfway through each token's life.
// A failed refresh is retried after 30 s, doubling to 15 min, while the
// token it has keeps working.
const (
	checkEvery   = time.Minute
	retryFirst   = 30 * time.Second
	retryMax     = 15 * time.Minute
	logoutWithin = 5 * time.Second
)

// Session keeps the signed-in Nuvio session: it restores it from the
// keychain, refreshes it and notices when it has ended. It is the only thing
// that refreshes. Refresh tokens rotate on use, so two refreshes with the
// same token can sign the user out (gotcha 6 of docs/spikes/nuvio-backend.md).
//
// It isn't a Wails service, so no token can be bound to the webview
// (ADR-0008). The sync module (#28) calls the backend through Do.
type Session struct {
	nuvio    backend.Remote
	keychain Keychain
	now      func() time.Time
	// Called, outside the lock, when a refresh finds the session has ended.
	onEnded func()

	// Held across refreshes, sign-in and sign-out, so the keychain and
	// current never disagree and only one refresh runs at a time.
	mu        sync.Mutex
	loaded    bool
	current   *nuvio.Session
	refreshAt time.Time
	failures  int
}

func newSession(client backend.Remote, keychain Keychain) *Session {
	return &Session{nuvio: client, keychain: keychain, now: time.Now, onEnded: func() {}}
}

// load reads the session from the keychain the first time it's needed.
// s.mu is held.
func (s *Session) load() error {
	if s.loaded {
		return nil
	}
	access, err := s.keychain.Get(KeyAccessToken)
	if err == nil {
		var refresh string
		refresh, err = s.keychain.Get(KeyRefreshToken)
		if err == nil {
			session := nuvio.SessionFromTokens(access, refresh)
			s.current = &session
			// Zero: refresh as soon as the loop runs.
			s.refreshAt = time.Time{}
		}
	}
	if err != nil && !errors.Is(err, secrets.ErrNotFound) {
		// The keychain can't answer (locked, or no Secret Service): try
		// again next time rather than decide the user is signed out.
		return err
	}
	s.loaded = true
	return nil
}

// SignedIn reports whether there is a session, without asking the backend,
// so it answers offline.
func (s *Session) SignedIn() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return false, err
	}
	return s.current != nil, nil
}

// Do calls fn with a session whose access token hasn't expired, refreshing
// first if it has. If the backend refuses the token anyway, it refreshes
// once and calls fn again. When the session has ended, it returns
// nuvio.ErrSignedOut.
func (s *Session) Do(ctx context.Context, fn func(nuvio.Session) error) error {
	session, err := s.fresh(ctx)
	if err != nil {
		return err
	}
	err = fn(session)
	if !errors.Is(err, nuvio.ErrSignedOut) {
		return err
	}
	if session, err = s.refreshFrom(ctx, session.RefreshToken); err != nil {
		return err
	}
	return fn(session)
}

// fresh returns the session, refreshed if its access token has expired.
func (s *Session) fresh(ctx context.Context) (nuvio.Session, error) {
	s.mu.Lock()
	if err := s.load(); err != nil {
		s.mu.Unlock()
		return nuvio.Session{}, err
	}
	if s.current == nil {
		s.mu.Unlock()
		return nuvio.Session{}, nuvio.ErrSignedOut
	}
	if expires := s.current.ExpiresAt; expires.IsZero() || s.now().Before(expires.Add(-time.Minute)) {
		defer s.mu.Unlock()
		return *s.current, nil
	}
	return s.refreshUnlock(ctx)
}

// refreshFrom refreshes the session unless it has been refreshed since
// stale, the refresh token the caller had, was current.
func (s *Session) refreshFrom(ctx context.Context, stale string) (nuvio.Session, error) {
	s.mu.Lock()
	if err := s.load(); err != nil {
		s.mu.Unlock()
		return nuvio.Session{}, err
	}
	if s.current == nil {
		s.mu.Unlock()
		return nuvio.Session{}, nuvio.ErrSignedOut
	}
	if s.current.RefreshToken != stale {
		defer s.mu.Unlock()
		return *s.current, nil
	}
	return s.refreshUnlock(ctx)
}

// refreshIfDue refreshes the session if it's time to. The loop calls it.
func (s *Session) refreshIfDue(ctx context.Context) error {
	s.mu.Lock()
	if err := s.load(); err != nil {
		s.mu.Unlock()
		return err
	}
	if s.current == nil || s.now().Before(s.refreshAt) {
		s.mu.Unlock()
		return nil
	}
	_, err := s.refreshUnlock(ctx)
	return err
}

// refreshUnlock swaps the refresh token for a new session and keeps it, then
// unlocks s.mu, which must be held. If the session has ended it deletes the
// tokens, leaving the account's profiles and data, and calls onEnded.
func (s *Session) refreshUnlock(ctx context.Context) (nuvio.Session, error) {
	session, err := s.nuvio.Refresh(ctx, s.current.RefreshToken)
	if errors.Is(err, nuvio.ErrSignedOut) {
		s.deleteTokens()
		s.current = nil
		s.mu.Unlock()
		s.onEnded()
		return nuvio.Session{}, err
	}
	defer s.mu.Unlock()
	if err != nil {
		s.failures++
		s.refreshAt = s.now().Add(min(retryFirst<<(s.failures-1), retryMax))
		return nuvio.Session{}, err
	}
	// The old refresh token no longer works, so keep the new session in
	// memory even if the keychain refuses it; the next refresh saves again.
	s.current = &session
	if err := s.saveTokens(session); err != nil {
		slog.Warn("account: keeping the refreshed session", "error", err)
	}
	s.schedule(session)
	return session, nil
}

// schedule sets the next refresh halfway to the access token's expiry, or an
// hour from now if the expiry isn't known. s.mu is held.
func (s *Session) schedule(session nuvio.Session) {
	s.failures = 0
	if session.ExpiresAt.IsZero() {
		s.refreshAt = s.now().Add(time.Hour)
		return
	}
	s.refreshAt = s.now().Add(session.ExpiresAt.Sub(s.now()) / 2)
}

// start keeps a new session after signing in, then calls link to save the
// account's profiles. If either fails, nothing is kept.
func (s *Session) start(session nuvio.Session, link func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	err := s.saveTokens(session)
	if err == nil {
		err = link()
	}
	if err != nil {
		s.deleteTokens()
		s.current, s.loaded = nil, true
		return err
	}
	s.current, s.loaded = &session, true
	s.schedule(session)
	return nil
}

// end signs out: it ends the session on the backend if it can, calls cleanup
// to remove the account's data, then deletes the tokens. A backend that
// can't be reached doesn't stop the sign-out; a cleanup that fails does, and
// the session is kept.
func (s *Session) end(ctx context.Context, cleanup func() error) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.load(); err != nil {
		return err
	}
	if s.current != nil {
		ctx, cancel := context.WithTimeout(ctx, logoutWithin)
		defer cancel()
		if err := s.nuvio.SignOut(ctx, *s.current); err != nil && !errors.Is(err, nuvio.ErrSignedOut) {
			slog.Warn("account: signing out on this device only", "error", err)
		}
	}
	if err := cleanup(); err != nil {
		return err
	}
	if err := s.deleteTokens(); err != nil {
		return err
	}
	s.current = nil
	return nil
}

// run refreshes the session when it's due until ctx is done. It checks the
// clock every tick rather than sleeping until the refresh is due, because
// timers don't count time asleep on macOS.
func (s *Session) run(ctx context.Context, tick time.Duration) {
	ticker := time.NewTicker(tick)
	defer ticker.Stop()
	for {
		if err := s.refreshIfDue(ctx); err != nil && ctx.Err() == nil &&
			!errors.Is(err, nuvio.ErrSignedOut) && !errors.Is(err, nuvio.ErrUnreachable) {
			slog.Warn("account: refresh failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}

// saveTokens keeps the refresh token first: with it, a half-saved session
// can still be refreshed. s.mu is held.
func (s *Session) saveTokens(session nuvio.Session) error {
	if err := s.keychain.Set(KeyRefreshToken, session.RefreshToken); err != nil {
		return err
	}
	return s.keychain.Set(KeyAccessToken, session.AccessToken)
}

// s.mu is held.
func (s *Session) deleteTokens() error {
	return errors.Join(s.keychain.Delete(KeyAccessToken), s.keychain.Delete(KeyRefreshToken))
}

// The sync module calls the backend through the session (#28).
var _ backend.Sessions = (*Session)(nil)
