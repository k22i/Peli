// Package account signs in to Nuvio and keeps the session: the tokens go to
// the OS keychain (ADR-0007) and the account's profiles to the local store.
// The frontend never sees a token (ADR-0008).
package account

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/secrets"
	"github.com/k22i/Sinag/internal/store"
)

// Keychain keys for the Nuvio session. The two tokens are stored apart to
// stay under the keychain's per-value cap (secrets.MaxSize).
const (
	KeyAccessToken  = "nuvio.access-token"
	KeyRefreshToken = "nuvio.refresh-token"
)

// Keychain is where the session is kept: *secrets.Keychain in the app.
type Keychain interface {
	Set(key, value string) error
	Delete(key string) error
	Available() error
}

// Service is the Wails service the frontend calls to sign in.
type Service struct {
	nuvio    *nuvio.Client
	keychain Keychain
	store    *store.Service

	// One sign-in at a time, so two can't race to write the session.
	mu sync.Mutex
}

// NewService returns a service that signs in with client, keeps the session
// in keychain and the profiles in store.
func NewService(client *nuvio.Client, keychain Keychain, store *store.Service) *Service {
	return &Service{nuvio: client, keychain: keychain, store: store}
}

// SignIn signs in to Nuvio with an email and password, keeps the session in
// the keychain and links the account's profiles. It returns the profile that
// is now current. Errors carry a code for the frontend (see MarshalError).
func (s *Service) SignIn(ctx context.Context, email, password string) (store.Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check first, so a Linux user with no Secret Service isn't signed in to
	// Nuvio for nothing.
	if err := s.keychain.Available(); err != nil {
		return store.Profile{}, err
	}
	session, err := s.nuvio.SignInWithPassword(ctx, strings.TrimSpace(email), password)
	if err != nil {
		return store.Profile{}, err
	}

	// No register_current_session: Nuvio accepts only its own apps' names
	// there, and Sinag doesn't pass itself off as one (ADR-0008).
	remote, err := s.nuvio.Profiles(ctx, session)
	if err != nil {
		return store.Profile{}, err
	}

	if err := s.saveSession(session); err != nil {
		return store.Profile{}, err
	}
	profiles := make([]store.Profile, len(remote))
	for i, p := range remote {
		profiles[i] = store.Profile{Name: p.Name, NuvioIndex: &p.Index}
	}
	linked, err := store.Opened(s.store).LinkNuvioProfiles(profiles)
	if err != nil {
		s.deleteSession()
		return store.Profile{}, err
	}
	if len(linked) == 0 {
		// Every Nuvio account has a profile; fall back rather than fail.
		return s.store.CurrentProfile()
	}
	return linked[0], nil
}

func (s *Service) saveSession(session nuvio.Session) error {
	if err := s.keychain.Set(KeyAccessToken, session.AccessToken); err != nil {
		return err
	}
	if err := s.keychain.Set(KeyRefreshToken, session.RefreshToken); err != nil {
		s.deleteSession()
		return err
	}
	return nil
}

func (s *Service) deleteSession() {
	s.keychain.Delete(KeyAccessToken)
	s.keychain.Delete(KeyRefreshToken)
}

// Error codes the frontend reads from a failed call's cause.code.
const (
	CodeInvalidCredentials  = "invalid_credentials"
	CodeRateLimited         = "rate_limited"
	CodeUnreachable         = "unreachable"
	CodeUnavailable         = "unavailable"
	CodeKeychainUnavailable = "keychain_unavailable"
)

// MarshalError gives the frontend a code for the errors it explains; Wails
// puts it in the rejected call's cause. Other errors keep Wails' default.
func MarshalError(err error) []byte {
	var code string
	switch {
	case errors.Is(err, nuvio.ErrInvalidCredentials):
		code = CodeInvalidCredentials
	case errors.Is(err, nuvio.ErrRateLimited):
		code = CodeRateLimited
	case errors.Is(err, nuvio.ErrUnreachable):
		code = CodeUnreachable
	case errors.Is(err, nuvio.ErrUnavailable):
		code = CodeUnavailable
	case errors.Is(err, secrets.ErrUnavailable):
		code = CodeKeychainUnavailable
	default:
		return nil
	}
	data, _ := json.Marshal(map[string]string{"code": code})
	return data
}
