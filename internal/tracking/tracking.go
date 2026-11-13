// Package tracking connects a profile to SIMKL and AniList (#71) and keeps
// them up to date: it signs in (#72, #104), scrobbles what the player plays
// to SIMKL (#73), updates the AniList list when an episode is watched
// (#105), and imports both into watched marks (#74, #105). Tokens are in the
// keychain, one set per profile; the frontend never sees one. See ADR-0042.
package tracking

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/anilist"
	"github.com/k22i/Peli/internal/animelist"
	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/secrets"
	"github.com/k22i/Peli/internal/simkl"
	"github.com/k22i/Peli/internal/store"
)

// EventImported tells the frontend an import added watched marks to a
// profile, so its watched, progress and continue-watching queries are stale.
const EventImported = "tracking:imported"

// EventChanged tells the frontend a profile's connections changed by
// themselves: a token stopped working.
const EventChanged = "tracking:changed"

func init() {
	application.RegisterEvent[uint64](EventImported)
	application.RegisterEvent[uint64](EventChanged)
}

// Services, as jobs and errors name them.
const (
	ServiceSimkl   = "simkl"
	ServiceAniList = "anilist"
)

// Keychain is where tokens are kept: *secrets.Keychain in the app.
type Keychain interface {
	Get(key string) (string, error)
	Set(key, value string) error
	Delete(key string) error
}

// The keychain keys of profile id's tokens.
func simklAccessKey(id uint64) string  { return "simkl.access-token." + strconv.FormatUint(id, 10) }
func simklRefreshKey(id uint64) string { return "simkl.refresh-token." + strconv.FormatUint(id, 10) }
func anilistKey(id uint64) string      { return "anilist.access-token." + strconv.FormatUint(id, 10) }

var (
	// ErrKidsProfile means kids profiles get no connection.
	ErrKidsProfile = errors.New("tracking: kids profiles can't connect")
	// ErrNotConnected means the profile has no such connection.
	ErrNotConnected = errors.New("tracking: not connected")
	// ErrNoSignIn means no sign-in is pending, or it was cancelled.
	ErrNoSignIn = errors.New("tracking: no sign-in pending")
	// ErrSignInExpired means the code ran out before it was approved.
	ErrSignInExpired = errors.New("tracking: sign-in expired")
	// ErrUnavailableHere means this build has no app registered with the
	// service.
	ErrUnavailableHere = errors.New("tracking: not available in this build")
)

// The apps Peli is registered as (public: a desktop app can't keep a
// secret, and neither flow needs one). $PELI_SIMKL_CLIENT_ID and
// $PELI_ANILIST_CLIENT_ID stand in for them, for a build of your own.
// SIMKL's is an AUTH V2 app of the "TV, devices & command line" kind,
// since Peli only uses the device flow; AniList's redirect URL is
// AniListRedirect.
const (
	SimklClientID   = "8105afefcfd3e6e85301f21b25c4efab4f43d4f8b5b511839c78870f08985261"
	AniListClientID = "55505"
)

// Config is what the service is built from.
type Config struct {
	Simkl   *simkl.Client
	AniList *anilist.Client
	// AniListClientID is the AniList app, whose redirect URL is
	// AniListRedirect; "" turns AniList off.
	AniListClientID string
	Anime           *animelist.List
	Keychain        Keychain
	Open            func() *store.Store
}

// Service is the Wails service Settings calls, and the scrobbler the player
// reports to.
type Service struct {
	simkl     *simkl.Client
	anilist   *anilist.Client
	anilistID string
	anime     *animelist.List
	keychain  Keychain
	open      func() *store.Store
	now       func() time.Time
	sleep     func(context.Context, time.Duration) error
	emit      func(name string, profileID uint64)
	// connected runs after a sign-in: an import, in the background.
	connected func(profileID uint64)

	// One refresh per profile at a time (SIMKL invalidates the old access
	// token on each).
	refreshMu sync.Mutex

	// Pending sign-ins, at most one of each.
	signInMu sync.Mutex
	simklIn  *simklSignIn
	aniIn    *aniListSignIn

	// SIMKL's lists as last fetched, by profile and kind, for TitleStatus.
	listsMu sync.Mutex
	lists   map[listKey]cachedLists

	// Imports, one per profile at a time, and when each last ran.
	importMu  sync.Mutex
	importing map[uint64]bool
	lastAuto  map[uint64]time.Time

	scrobbler *scrobbler
	stop      context.CancelFunc
}

// NewService returns a Service from cfg.
func NewService(cfg Config) *Service {
	s := &Service{
		simkl: cfg.Simkl, anilist: cfg.AniList, anilistID: cfg.AniListClientID, anime: cfg.Anime,
		keychain: cfg.Keychain, open: cfg.Open, now: time.Now, sleep: sleep,
		emit:  func(string, uint64) {},
		lists: map[listKey]cachedLists{}, importing: map[uint64]bool{}, lastAuto: map[uint64]time.Time{},
	}
	s.scrobbler = newScrobbler(s)
	s.connected = func(id uint64) {
		go func() {
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
			defer cancel()
			if _, err := s.Import(ctx, id); err != nil {
				slog.Info("tracking: import after connecting failed", "error", err)
			}
		}()
	}
	return s
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return ctx.Err()
	case <-t.C:
		return nil
	}
}

// ServiceStartup starts the scrobbler and the queue of jobs to resend, and
// forgets the tokens of profiles deleted since.
func (s *Service) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	if app := application.Get(); app != nil {
		s.emit = func(name string, id uint64) { app.Event.Emit(name, id) }
	}
	ctx, s.stop = context.WithCancel(context.WithoutCancel(ctx))
	s.forgetDeleted()
	go s.scrobbler.run(ctx)
	if db := s.open(); db != nil && s.anime != nil {
		if tracked, err := db.TrackedProfiles(); err == nil && len(tracked) > 0 {
			go s.anime.Warm(ctx)
		}
	}
	return nil
}

// ServiceShutdown sends what the player reported last (the stop of what was
// playing), waiting a few seconds at most. List the service before the
// player, so it shuts down after it.
func (s *Service) ServiceShutdown() error {
	s.scrobbler.drain(5 * time.Second)
	if s.stop != nil {
		s.stop()
	}
	return nil
}

// Report hands a player report to the scrobbler. It never waits on the
// network. It isn't a method, so Wails doesn't bind it.
func Report(s *Service, r playback.Report) { s.scrobbler.report(r) }

// Kick has the scrobbler look at its queue of kept jobs now, for the app
// coming back from suspension: its retry timer is a monotonic one, which
// doesn't count a sleeping device, so a job already due would otherwise wait
// out what was left of it. Jobs not yet due stay queued. Like Report it
// isn't a method, so Wails doesn't bind it.
func Kick(s *Service) {
	select {
	case s.scrobbler.kick <- struct{}{}:
	default:
	}
}

// Drain waits up to d for the reports given to Report to be handled (the
// stop of what was just paused or left), for the app going to the
// background, where the process is about to be suspended.
func Drain(s *Service, d time.Duration) { s.scrobbler.drain(d) }

// --- status ------------------------------------------------------------------

// Connections are a profile's connections, for Settings.
type Connections struct {
	// Whether this build can connect at all.
	SimklAvailable   bool `json:"simklAvailable"`
	AniListAvailable bool `json:"anilistAvailable"`
	// Kids profiles connect to neither.
	Kids    bool           `json:"kids"`
	Simkl   *SimklStatus   `json:"simkl"`
	AniList *AniListStatus `json:"anilist"`
}

// SimklStatus is a connected SIMKL account.
type SimklStatus struct {
	User           string `json:"user"`
	NeedsReconnect bool   `json:"needsReconnect"`
	// When the history was last imported, Unix ms; 0 for never.
	ImportedAt int64 `json:"importedAt"`
}

// AniListStatus is a connected AniList account.
type AniListStatus struct {
	User           string `json:"user"`
	NeedsReconnect bool   `json:"needsReconnect"`
	// When the token runs out, Unix ms; connect again then.
	Expires    int64 `json:"expires"`
	ImportedAt int64 `json:"importedAt"`
}

// Status returns profile id's connections.
func (s *Service) Status(profileID uint64) (Connections, error) {
	db := s.open()
	if db == nil {
		return Connections{}, errors.New("tracking: store not open")
	}
	profile, err := db.Profile(profileID)
	if err != nil {
		return Connections{}, err
	}
	t, err := db.Tracking(profileID)
	if err != nil {
		return Connections{}, err
	}
	c := Connections{SimklAvailable: s.simkl.Configured(), AniListAvailable: s.anilistID != "", Kids: profile.Kids}
	if l := t.Simkl; l != nil {
		c.Simkl = &SimklStatus{User: l.User, NeedsReconnect: l.NeedsReconnect, ImportedAt: l.ImportedAt}
	}
	if l := t.AniList; l != nil {
		expired := l.Expires > 0 && s.now().UnixMilli() >= l.Expires
		c.AniList = &AniListStatus{User: l.User, NeedsReconnect: l.NeedsReconnect || expired, Expires: l.Expires, ImportedAt: l.ImportedAt}
	}
	return c, nil
}

// canConnect refuses kids profiles.
func (s *Service) canConnect(profileID uint64) error {
	db := s.open()
	if db == nil {
		return errors.New("tracking: store not open")
	}
	profile, err := db.Profile(profileID)
	if err != nil {
		return err
	}
	if profile.Kids {
		return ErrKidsProfile
	}
	return nil
}

// settings returns profile id's tracking settings, or the defaults.
func (s *Service) settings(db *store.Store, profileID uint64) store.ProfileSettings {
	settings, err := db.ProfileSettings(profileID)
	if err != nil {
		return store.DefaultProfileSettings()
	}
	return settings
}

// forgetDeleted removes the tokens a deleted profile left in the keychain:
// the store keeps which profiles were given tokens, apart from the profiles.
func (s *Service) forgetDeleted() {
	db := s.open()
	if db == nil {
		return
	}
	owners, err := db.TrackingTokenOwners()
	if err != nil {
		return
	}
	tracked, err := db.TrackedProfiles()
	if err != nil {
		return
	}
	for _, id := range owners {
		if tracked[id] {
			continue
		}
		s.forgetTokens(id, ServiceSimkl)
		s.forgetTokens(id, ServiceAniList)
		_ = db.SetTrackingTokenOwner(id, false)
	}
}

func (s *Service) forgetTokens(profileID uint64, service string) {
	keys := []string{anilistKey(profileID)}
	if service == ServiceSimkl {
		keys = []string{simklAccessKey(profileID), simklRefreshKey(profileID)}
	}
	for _, key := range keys {
		if err := s.keychain.Delete(key); err != nil && !errors.Is(err, secrets.ErrNotFound) {
			slog.Warn("tracking: token not removed", "service", service, "error", err)
		}
	}
}

// --- errors for the frontend ----------------------------------------------------

// Error codes the frontend reads from a failed call's cause.code.
const (
	CodeKidsProfile         = "kids_profile"
	CodeNotConnected        = "not_connected"
	CodeSignInExpired       = "sign_in_expired"
	CodeNoSignIn            = "no_sign_in"
	CodeUnavailableHere     = "unavailable_here"
	CodeUnreachable         = "unreachable"
	CodeUnavailable         = "unavailable"
	CodeRateLimited         = "rate_limited"
	CodeReadOnly            = "read_only"
	CodeRefused             = "refused"
	CodeKeychainUnavailable = "keychain_unavailable"
	CodePortInUse           = "port_in_use"
)

// MarshalError gives the frontend a code for the errors it explains.
func MarshalError(err error) []byte {
	var simklLimited *simkl.RateLimited
	var aniLimited *anilist.RateLimited
	var code string
	switch {
	case errors.Is(err, ErrKidsProfile):
		code = CodeKidsProfile
	case errors.Is(err, ErrNotConnected):
		code = CodeNotConnected
	case errors.Is(err, ErrNotTrackable):
		code = CodeNotTrackable
	case errors.Is(err, ErrSignInExpired), errors.Is(err, simkl.ErrCodeGone):
		code = CodeSignInExpired
	case errors.Is(err, ErrNoSignIn):
		code = CodeNoSignIn
	case errors.Is(err, ErrUnavailableHere), errors.Is(err, simkl.ErrNoClientID):
		code = CodeUnavailableHere
	case errors.Is(err, simkl.ErrUnreachable), errors.Is(err, anilist.ErrUnreachable):
		code = CodeUnreachable
	case errors.Is(err, simkl.ErrUnavailable), errors.Is(err, anilist.ErrUnavailable):
		code = CodeUnavailable
	case errors.As(err, &simklLimited), errors.As(err, &aniLimited):
		code = CodeRateLimited
	case errors.Is(err, simkl.ErrReadOnly):
		code = CodeReadOnly
	case errors.Is(err, simkl.ErrUnauthorized), errors.Is(err, anilist.ErrUnauthorized):
		code = CodeRefused
	case errors.Is(err, secrets.ErrUnavailable):
		code = CodeKeychainUnavailable
	case errors.Is(err, errPortInUse):
		code = CodePortInUse
	default:
		return nil
	}
	data, _ := json.Marshal(map[string]string{"code": code})
	return data
}

// wrap names the call in errors that aren't explained to the user.
func wrap(what string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("tracking: %s: %w", what, err)
}
