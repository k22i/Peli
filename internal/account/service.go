// Package account signs in to Nuvio and keeps the session: the tokens go to
// the OS keychain (ADR-0007) and the account's profiles to the local store.
// The frontend never sees a token (ADR-0008). The session's lifecycle
// (restore, refresh, revoked, sign out) is ADR-0009.
package account

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"

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

// EventSessionEnded tells the frontend the session ended without the user
// signing out: it was revoked, or its refresh token stopped working. The
// account's profiles and data are kept.
const EventSessionEnded = "account:session-ended"

func init() {
	application.RegisterEvent[application.Void](EventSessionEnded)
}

// Keychain is where the session is kept: *secrets.Keychain in the app.
type Keychain interface {
	Get(key string) (string, error)
	Set(key, value string) error
	Delete(key string) error
	Available() error
}

// Service is the Wails service the frontend calls to sign in and out.
type Service struct {
	nuvio   *nuvio.Client
	session *Session
	store   *store.Service

	// One sign-in or sign-out at a time.
	mu sync.Mutex
	// Stops the refresh loop.
	stop context.CancelFunc
}

// NewService returns a service that signs in with client, keeps the session
// in keychain and the profiles in store.
func NewService(client *nuvio.Client, keychain Keychain, store *store.Service) *Service {
	return &Service{nuvio: client, session: newSession(client, keychain), store: store}
}

// SessionOf returns service's session, for calling the backend from Go. It
// isn't a method, so Wails doesn't bind it.
func SessionOf(service *Service) *Session { return service.session }

// ServiceStartup starts refreshing the session in the background, starting
// now. Nothing waits for it: the app opens from the keychain and the local
// store, online or not.
func (s *Service) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	if app := application.Get(); app != nil {
		s.session.onEnded = func() { app.Event.Emit(EventSessionEnded) }
	}
	ctx, s.stop = context.WithCancel(context.WithoutCancel(ctx))
	go s.session.run(ctx, checkEvery)
	return nil
}

func (s *Service) ServiceShutdown() error {
	if s.stop != nil {
		s.stop()
	}
	return nil
}

// Status is whether there is a Nuvio session on this device.
type Status struct {
	SignedIn bool `json:"signedIn"`
	// The session ended without signing out (revoked, or its refresh token
	// stopped working) and the account's profiles are still here: sign in
	// again to carry on syncing them.
	SessionEnded bool `json:"sessionEnded"`
}

// Status answers from the keychain and the local store, never the backend,
// so it works offline.
func (s *Service) Status() (Status, error) {
	signedIn, err := s.session.SignedIn()
	if errors.Is(err, secrets.ErrUnavailable) {
		// No keychain (Linux with no Secret Service): no session either.
		signedIn, err = false, nil
	}
	if err != nil || signedIn {
		return Status{SignedIn: signedIn}, err
	}
	linked, err := store.Opened(s.store).HasNuvioProfiles()
	return Status{SessionEnded: linked}, err
}

// SignIn signs in to Nuvio with an email and password, keeps the session in
// the keychain and links the account's profiles. It returns the profile that
// is now current. Errors carry a code for the frontend (see MarshalError).
func (s *Service) SignIn(ctx context.Context, email, password string) (store.Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	// Check first, so a Linux user with no Secret Service isn't signed in to
	// Nuvio for nothing.
	if err := s.session.keychain.Available(); err != nil {
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

	profiles := make([]store.Profile, len(remote))
	for i, p := range remote {
		profiles[i] = store.Profile{Name: p.Name, NuvioIndex: &p.Index}
	}
	var linked []store.Profile
	err = s.session.start(session, func() error {
		// Another account's profiles, left after its session ended, are
		// removed rather than merged by index.
		linked, err = store.Opened(s.store).LinkNuvioProfiles(session.UserID, profiles)
		return err
	})
	if err != nil {
		return store.Profile{}, err
	}
	if len(linked) == 0 {
		// Every Nuvio account has a profile; fall back rather than fail.
		return s.store.CurrentProfile()
	}
	return linked[0], nil
}

// SignOut ends the session on the backend (other devices stay signed in),
// deletes the tokens, and removes the account's profiles and everything in
// them, and the cache: Nuvio has the account's data, and signing in again
// pulls it back. Local-only profiles such as a guest's stay. Changes not yet
// pushed are lost until the sync module (#28) flushes them first.
func (s *Service) SignOut(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.session.end(ctx, func() error {
		db := store.Opened(s.store)
		return errors.Join(db.RemoveNuvioProfiles(), db.ClearCache())
	})
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
