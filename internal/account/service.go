// Package account signs in to Nuvio and keeps the session: the tokens go to
// the OS keychain (ADR-0007) and the account's profiles to the local store.
// The frontend never sees a token (ADR-0008). The session's lifecycle
// (restore, refresh, revoked, sign out) is ADR-0009.
package account

import (
	"context"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Sinag/internal/backend"
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
	nuvio   backend.Remote
	session *Session
	store   *store.Service

	// One sign-in or sign-out at a time.
	mu sync.Mutex
	// Profiles unlocked this session (their PIN was entered correctly), by
	// profile ID (#25).
	unlocked map[uint64]bool
	// Until when each kids profile's parent PIN is approved (#26).
	parent map[uint64]time.Time
	now    func() time.Time
	// Stops the refresh loop.
	stop context.CancelFunc

	// Sends what is queued before a sign-out removes it (#30).
	flusher Flusher

	// QR sign-in (qr.go): where the phone approves it, the name it shows,
	// and the sign-in pending.
	linkURL    string
	deviceName string
	sleep      func(context.Context, time.Duration) error
	qrMu       sync.Mutex
	qr         *qrSignIn
}

// NewService returns a service that signs in with client, keeps the session
// in keychain and the profiles in store.
func NewService(client backend.Remote, keychain Keychain, store *store.Service) *Service {
	return &Service{
		nuvio: client, session: newSession(client, keychain), store: store,
		unlocked: map[uint64]bool{}, parent: map[uint64]time.Time{}, now: time.Now,
		linkURL: nuvio.DefaultLinkURL, deviceName: deviceName(), sleep: sleep,
	}
}

// Flusher pushes everything queued to Nuvio: *syncer.Pusher in the app.
type Flusher interface {
	Flush(ctx context.Context) error
}

// flushWithin is how long a sign-out waits to send what is queued. Offline,
// the push fails at once and the sign-out goes ahead.
const flushWithin = 10 * time.Second

// FlushOnSignOut has service send what is queued before it signs out. It
// isn't a method, so Wails doesn't bind it.
func FlushOnSignOut(service *Service, flusher Flusher) { service.flusher = flusher }

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
	return s.signIn(ctx, func(ctx context.Context) (nuvio.Session, error) {
		return s.nuvio.SignInWithPassword(ctx, strings.TrimSpace(email), password)
	})
}

// signIn gets a session from newSession, keeps it in the keychain and links
// the account's profiles: the part of signing in that email and QR share. It
// returns the profile that is now current. If a step after newSession fails,
// nothing is kept and the session is ended on the backend.
func (s *Service) signIn(ctx context.Context, newSession func(context.Context) (nuvio.Session, error)) (store.Profile, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	// Signing in makes another profile current, which leaves a kids profile.
	if err := s.guardKids(store.Opened(s.store), nil); err != nil {
		return store.Profile{}, err
	}

	// Check first, so a Linux user with no Secret Service isn't signed in to
	// Nuvio for nothing.
	if err := s.session.keychain.Available(); err != nil {
		return store.Profile{}, err
	}
	// The avatar catalog is public, so it loads while signing in.
	avatars := make(chan map[string]string, 1)
	go func() { avatars <- s.avatarImages(ctx) }()

	session, err := newSession(ctx)
	if err != nil {
		return store.Profile{}, err
	}
	linked, err := s.link(ctx, session, avatars)
	if err != nil {
		ctx, cancel := context.WithTimeout(context.WithoutCancel(ctx), logoutWithin)
		defer cancel()
		s.nuvio.SignOut(ctx, session)
		return store.Profile{}, err
	}
	if len(linked) == 0 {
		// Every Nuvio account has a profile; fall back rather than fail.
		return s.store.CurrentProfile()
	}
	return linked[0], nil
}

// link pulls the account's profiles, then keeps the session and links them.
func (s *Service) link(ctx context.Context, session nuvio.Session, avatars <-chan map[string]string) ([]store.Profile, error) {
	// No register_current_session: Nuvio accepts only its own apps' names
	// there, and Sinag doesn't pass itself off as one (ADR-0008).
	remote, err := s.nuvio.Profiles(ctx, session)
	if err != nil {
		return nil, err
	}

	images := <-avatars
	profiles := make([]store.Profile, len(remote))
	for i, p := range remote {
		profiles[i] = fromNuvio(p, images)
	}
	// The locks are the authoritative PIN state; the profiles pull carries
	// the same fields, so an error here is ignored.
	if locks, err := s.nuvio.ProfileLocks(ctx, session); err == nil {
		for i := range profiles {
			for _, lock := range locks {
				if profiles[i].NuvioIndex != nil && *profiles[i].NuvioIndex == lock.Index {
					profiles[i].PinEnabled = lock.PinEnabled
					profiles[i].PinLockedUntil = lock.PinLockedUntil
				}
			}
		}
	}
	var linked []store.Profile
	err = s.session.start(session, func() error {
		// Another account's profiles, left after its session ended, are
		// removed rather than merged by index.
		linked, err = store.Opened(s.store).LinkNuvioProfiles(session.UserID, profiles)
		return err
	})
	return linked, err
}

// avatarImages returns the image of each stock avatar by its ID, or nil if
// the catalog can't be read: the picker then shows initials (#24).
func (s *Service) avatarImages(ctx context.Context) map[string]string {
	catalog, err := s.nuvio.AvatarCatalog(ctx)
	if err != nil {
		return nil
	}
	images := make(map[string]string, len(catalog))
	for _, a := range catalog {
		images[a.ID] = s.nuvio.AvatarImageURL(a)
	}
	return images
}

// avatarImage returns a Nuvio profile's avatar image: its own URL if it has
// one, or else its stock avatar's.
func avatarImage(p nuvio.Profile, images map[string]string) string {
	if p.AvatarURL != nil {
		if u, err := url.Parse(*p.AvatarURL); err == nil && (u.Scheme == "https" || u.Scheme == "http") {
			return u.String()
		}
	}
	if p.AvatarID == nil {
		return ""
	}
	return images[*p.AvatarID]
}

// hexColor returns color if it is "#rrggbb", or else "".
func hexColor(color string) string {
	if len(color) != 7 || color[0] != '#' {
		return ""
	}
	if _, err := hex.DecodeString(color[1:]); err != nil {
		return ""
	}
	return strings.ToUpper(color)
}

// SignOut ends the session on the backend (other devices stay signed in),
// deletes the tokens, and removes the account's profiles and everything in
// them, and the cache: Nuvio has the account's data, and signing in again
// pulls it back. Local-only profiles such as a guest's stay. Queued changes
// are pushed first, while the session still works; those that can't be sent
// (offline, say) are lost.
func (s *Service) SignOut(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if err := s.guardKids(store.Opened(s.store), nil); err != nil {
		return err
	}
	if s.flusher != nil {
		flushCtx, cancel := context.WithTimeout(ctx, flushWithin)
		if err := s.flusher.Flush(flushCtx); err != nil && !backend.Offline(err) {
			slog.Warn("account: signing out with changes not pushed", "error", err)
		}
		cancel()
	}
	return s.session.end(ctx, func() error {
		db := store.Opened(s.store)
		return errors.Join(db.RemoveNuvioProfiles(), db.ClearCache())
	})
}

// ErrProfileLocked means the profile needs its PIN before it can be used
// (#25).
var ErrProfileLocked = errors.New("account: profile is PIN-locked")

// ErrWrongPIN means the PIN entered for a profile was wrong. RetryAfter is
// how many seconds to wait before trying again.
type ErrWrongPIN struct{ RetryAfter int }

func (e *ErrWrongPIN) Error() string {
	return fmt.Sprintf("account: wrong PIN, retry in %d seconds", e.RetryAfter)
}

// ErrPINFormat means the PIN isn't exactly four digits (0–9), the format
// Nuvio enforces (#25).
var ErrPINFormat = errors.New("account: PIN must be exactly 4 digits")

// Error codes the frontend reads from a failed call's cause.code.
const (
	CodeInvalidCredentials  = "invalid_credentials"
	CodeRateLimited         = "rate_limited"
	CodeUnreachable         = "unreachable"
	CodeUnavailable         = "unavailable"
	CodeKeychainUnavailable = "keychain_unavailable"
	// The QR sign-in's code expired (#21).
	CodeQRExpired = "qr_expired"
	// Managing profiles (#95).
	CodeSignedOut       = "signed_out"
	CodeProfileNotFound = "profile_not_found"
	CodeProfilesFull    = "profiles_full"
	CodePrimaryProfile  = "primary_profile"
	CodeLastProfile     = "last_profile"
	CodeInvalidProfile  = "invalid_profile"
	// PIN-locked profiles (#25).
	CodeProfileLocked = "profile_locked"
	CodeWrongPIN      = "wrong_pin"
	CodeInvalidPIN    = "invalid_pin"
	// Kids profiles (#26).
	CodeParentPINRequired = "parent_pin_required"
	CodeKidsNeedsPIN      = "kids_need_pin"
	CodeKidsKeepsPIN      = "kids_keep_pin"
)

// MarshalError gives the frontend a code for the errors it explains; Wails
// puts it in the rejected call's cause. Other errors keep Wails' default.
func MarshalError(err error) []byte {
	var wrongPIN *ErrWrongPIN
	if errors.As(err, &wrongPIN) {
		data, _ := json.Marshal(map[string]any{"code": CodeWrongPIN, "retryAfterSeconds": wrongPIN.RetryAfter})
		return data
	}
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
	case errors.Is(err, nuvio.ErrDeviceLoginExpired):
		code = CodeQRExpired
	case errors.Is(err, nuvio.ErrSignedOut):
		code = CodeSignedOut
	case errors.Is(err, nuvio.ErrProfileNotFound):
		code = CodeProfileNotFound
	case errors.Is(err, ErrProfilesFull):
		code = CodeProfilesFull
	case errors.Is(err, ErrPrimaryProfile):
		code = CodePrimaryProfile
	case errors.Is(err, ErrLastProfile):
		code = CodeLastProfile
	case errors.Is(err, store.ErrInvalidProfile):
		code = CodeInvalidProfile
	case errors.Is(err, ErrProfileLocked):
		code = CodeProfileLocked
	case errors.Is(err, ErrPINFormat):
		code = CodeInvalidPIN
	case errors.Is(err, ErrParentPINRequired), errors.Is(err, store.ErrKidsProfile):
		code = CodeParentPINRequired
	case errors.Is(err, ErrKidsNeedsPIN):
		code = CodeKidsNeedsPIN
	case errors.Is(err, ErrKidsKeepsPIN):
		code = CodeKidsKeepsPIN
	default:
		return nil
	}
	data, _ := json.Marshal(map[string]string{"code": code})
	return data
}

// fourDigits reports whether pin is exactly four digits (0–9), the format
// Nuvio enforces (#25).
func fourDigits(pin string) bool {
	if len(pin) != 4 {
		return false
	}
	for _, r := range pin {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// currentPINRequired reports whether err is Nuvio refusing a PIN change or
// removal because the current PIN is missing or wrong (#25).
func currentPINRequired(err error) bool {
	var apiErr *nuvio.APIError
	return errors.As(err, &apiErr) && apiErr.Code == "P0001" &&
		strings.HasPrefix(apiErr.Message, "Current PIN is required")
}

// pinFormatErr reports whether err is Nuvio refusing a PIN that isn't four
// digits (#25).
func pinFormatErr(err error) bool {
	var apiErr *nuvio.APIError
	return errors.As(err, &apiErr) && apiErr.Code == "P0001" &&
		strings.Contains(apiErr.Message, "PIN must be exactly 4 digits")
}
