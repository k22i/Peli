// Package updates keeps Peli up to date (#83, ADR-0054). It asks a signed
// feed for a newer release, downloads and checks it in the background, and
// says when it's ready. Peli only restarts into it when the user says so,
// and never while something is playing.
//
// The work is Wails' updater's (download, signature check, the helper that
// swaps the app and relaunches it). This package adds Peli's rules: every
// release must be signed, the new app must be the version the feed named and
// signed by the same team, and updates only run from a copy of Peli that can
// replace itself.
package updates

import (
	"cmp"
	"context"
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/updater"

	"github.com/k22i/Peli/internal/store"
)

// State is where the updater is.
type State string

const (
	// Off: this copy of Peli can't update itself; Reason says why.
	Off      State = "off"
	Idle     State = "idle"
	Checking State = "checking"
	UpToDate State = "up-to-date"
	// Available: a manual check found a release and nothing is downloading
	// yet. It waits for the user's yes: "Download" in Settings.
	Available   State = "available"
	Downloading State = "downloading"
	// Ready: the new version is downloaded and checked, and installs when
	// the user restarts Peli.
	Ready State = "ready"
	// Failed: the last check or download didn't work; Problem says what.
	// Peli tries again later.
	Failed State = "failed"
)

// Reason is why updates are off.
type Reason string

const (
	// Development: a build without a release version (go run, wails dev).
	Development Reason = "development"
	// NotInstalled: Peli runs from the disk image, a download folder macOS
	// moved it out of (App Translocation), or outside an app bundle.
	NotInstalled Reason = "not-installed"
	// ReadOnly: Peli can't write to the folder it's in.
	ReadOnly Reason = "read-only"
	// Unsupported: this OS doesn't have an install strategy yet (Windows
	// waits for its installer, #77; Linux is deferred, #103).
	Unsupported Reason = "unsupported"
)

// Status is what the frontend shows: in Settings › About, and as the
// "update ready" prompt.
type Status struct {
	State   State  `json:"state"`
	Reason  Reason `json:"reason,omitempty"`
	Current string `json:"current"`
	// The release found, from Available on.
	Version string `json:"version,omitempty"`
	Notes   string `json:"notes,omitempty"`
	// Bytes downloaded and the download's size, while Downloading.
	Written int64  `json:"written,omitempty"`
	Total   int64  `json:"total,omitempty"`
	Problem string `json:"problem,omitempty"`
	// When Peli last heard from the feed, in Unix milliseconds; 0 for never.
	CheckedAt int64 `json:"checkedAt,omitempty"`
}

// EventStatus tells the frontend the status changed. Its data is a Status.
const EventStatus = "updates:status"

func init() {
	application.RegisterEvent[Status](EventStatus)
}

var (
	ErrOff      = errors.New("updates: this copy of Peli can't update itself")
	ErrNotReady = errors.New("updates: no update is ready")
	// ErrPlaying: Peli won't restart while something is playing.
	ErrPlaying = errors.New("updates: something is playing")
	// ErrMismatch: the downloaded app isn't the release the feed named, or
	// isn't signed like this one.
	ErrMismatch = errors.New("updates: the downloaded app doesn't match")
)

// Error codes for the frontend.
const (
	CodeOff         = "off"
	CodeNotReady    = "not-ready"
	CodePlaying     = "playing"
	CodeUnavailable = "unavailable"
)

// MarshalError gives the frontend a code for err.
func MarshalError(err error) []byte {
	code := CodeUnavailable
	switch {
	case errors.Is(err, ErrOff):
		code = CodeOff
	case errors.Is(err, ErrNotReady):
		code = CodeNotReady
	case errors.Is(err, ErrPlaying):
		code = CodePlaying
	}
	data, _ := json.Marshal(map[string]string{"code": code})
	return data
}

// How often Peli looks: a minute after launch, so it never slows the start,
// then every six hours while it runs, or an hour after a failure.
const (
	FirstCheck = time.Minute
	CheckEvery = 6 * time.Hour
	RetryAfter = time.Hour
	// wake is how often the loop looks at the clock. A timer for six hours
	// would run late after the Mac sleeps.
	wake = 15 * time.Minute
)

// Engine is Wails' updater, as the service drives it.
type Engine interface {
	Check(context.Context) (*updater.Release, error)
	DownloadAndInstall(context.Context) error
	DownloadedPath() string
	Restart(context.Context) error
}

// Settings has the device's settings: AutoUpdate turns the background checks
// off. "Check now" in Settings still works.
type Settings interface {
	DeviceSettings() (store.DeviceSettings, error)
}

// Installed is the copy of Peli that's running, as the OS has it.
type Installed interface {
	// Where is the app to replace, or why it can't be.
	Where() (string, Reason)
	// Check is whether staged, a downloaded app, may replace target: the
	// release's version, the same app, signed by the same team.
	Check(staged, target, version string) error
}

// Service is the Wails service the frontend asks about updates.
type Service struct {
	version   string
	userAgent string
	installed Installed
	key       ed25519.PublicKey
	newEngine func(url string) (Engine, error)

	// Set by UseSettings and UsePlayer; nil until then.
	settings Settings
	playing  func() bool

	emit func(Status)
	now  func() time.Time

	mu      sync.Mutex
	status  Status
	target  string
	engine  Engine
	release *updater.Release // what the last check found, for Download
	running bool
	next    time.Time // when the loop next checks by itself
	ctx     context.Context
	cancel  context.CancelFunc
	done    chan struct{}
}

// NewService returns the updater for Peli version, which it compares
// releases with.
func NewService(version string) *Service {
	s := &Service{
		version:   version,
		userAgent: fmt.Sprintf("Peli/%s (+https://github.com/k22i/Peli)", version),
		installed: installed{},
		key:       publicKey(),
		emit:      func(Status) {},
		now:       time.Now,
		status:    Status{State: Idle, Current: version},
	}
	s.newEngine = s.wailsEngine
	return s
}

// UseSettings has the service check by itself only while the device's
// settings allow it. It isn't a method, so Wails doesn't bind it.
func UseSettings(s *Service, settings Settings) { s.settings = settings }

// UsePlayer tells the service whether something is playing, so it never
// restarts then. It isn't a method, so Wails doesn't bind it.
func UsePlayer(s *Service, playing func() bool) { s.playing = playing }

// wailsEngine sets up the app's updater: Peli's feed, Peli's key, and no
// window of its own (the frontend shows the status).
func (s *Service) wailsEngine(url string) (Engine, error) {
	app := application.Get()
	if app == nil || app.Updater == nil {
		return nil, errors.New("updates: no app")
	}
	return s.configure(app.Updater, url)
}

// configure points u at the feed at url, trusting only s.key.
func (s *Service) configure(u *updater.Updater, url string) (Engine, error) {
	provider, err := newProvider(url, s.userAgent)
	if err != nil {
		return nil, err
	}
	err = u.Init(updater.Config{
		CurrentVersion: s.version,
		Providers:      []updater.Provider{provider},
		PublicKey:      s.key,
		Window:         updater.WindowNone,
	})
	return u, err
}

// ServiceStartup works out whether this copy can update itself and, if it
// can, starts looking for releases.
func (s *Service) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	if app := application.Get(); app != nil {
		s.emit = func(st Status) { app.Event.Emit(EventStatus, st) }
		app.Event.On(updater.EventDownloadProgress, func(e *application.CustomEvent) {
			if p, ok := e.Data.(updater.Progress); ok {
				s.progress(p.Written, p.Total)
			}
		})
	}
	return s.start(cmp.Or(os.Getenv("PELI_UPDATE_URL"), FeedURL))
}

func (s *Service) start(url string) error {
	target, reason := s.where()
	if reason != "" {
		s.set(func(st *Status) { *st = Status{State: Off, Reason: reason, Current: s.version} })
		return nil
	}
	engine, err := s.newEngine(url)
	if err == nil && len(s.key) == 0 {
		err = errors.New("no release key (internal/updates.PublicKey)")
	}
	if err != nil {
		// Peli runs as usual without updates.
		log.Printf("updates: %v", err)
		s.set(func(st *Status) { *st = Status{State: Off, Reason: Unsupported, Current: s.version} })
		return nil
	}
	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.target, s.engine, s.ctx, s.cancel, s.done = target, engine, ctx, cancel, make(chan struct{})
	s.next = s.now().Add(FirstCheck)
	s.mu.Unlock()
	go s.loop(ctx)
	return nil
}

// where is the app to replace, or why there's none.
func (s *Service) where() (string, Reason) {
	if !isRelease(s.version) {
		return "", Development
	}
	return s.installed.Where()
}

// isRelease is whether version is a release's: x.y.z, maybe with a
// pre-release, and not the 0.0.0-dev of an unstamped build.
func isRelease(version string) bool {
	core, _, _ := strings.Cut(strings.TrimPrefix(version, "v"), "-")
	parts := strings.Split(core, ".")
	if len(parts) != 3 || core == "0.0.0" {
		return false
	}
	for _, p := range parts {
		if p == "" || strings.Trim(p, "0123456789") != "" {
			return false
		}
	}
	return true
}

// ServiceShutdown stops the loop and any download. A ready update stays
// unused: the next launch finds it again.
func (s *Service) ServiceShutdown() error {
	s.mu.Lock()
	cancel, done := s.cancel, s.done
	s.mu.Unlock()
	if cancel != nil {
		cancel()
		<-done
	}
	return nil
}

func (s *Service) loop(ctx context.Context) {
	defer close(s.done)
	t := time.NewTicker(wake)
	defer t.Stop()
	first := time.NewTimer(FirstCheck)
	defer first.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-first.C:
		case <-t.C:
		}
		s.mu.Lock()
		due := !s.now().Before(s.next)
		s.mu.Unlock()
		if due && s.automatic() {
			s.run()
		}
	}
}

// automatic is whether the device's settings let Peli check by itself.
func (s *Service) automatic() bool {
	if s.settings == nil {
		return true
	}
	settings, err := s.settings.DeviceSettings()
	return err != nil || settings.AutoUpdate
}

// Status returns where the updater is.
func (s *Service) Status() Status {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.status
}

// Check looks for a release now, for "Check now" in Settings. It downloads
// nothing: when the feed names a release the status says it's available, and
// Peli waits for the user to say "Download". It returns once the check has
// started; the status events say how it goes.
func (s *Service) Check() (Status, error) {
	ctx, engine, _, ok, err := s.claim()
	if err != nil || !ok {
		return s.Status(), err
	}
	go func() {
		defer s.unclaim()
		rel, found := s.look(ctx, engine)
		if !found || rel == nil {
			return
		}
		s.set(func(st *Status) { st.State = Available })
	}()
	return s.Status(), nil
}

// Download downloads and checks the release the last check found, for the
// "Download" button in Settings: the answer to the question a manual check
// asks. The background check doesn't ask — the device's automatic updates
// setting says it may download by itself.
func (s *Service) Download() (Status, error) {
	s.mu.Lock()
	off := s.engine == nil
	rel, available := s.release, s.status.State == Available
	s.mu.Unlock()
	if off {
		return s.Status(), ErrOff
	}
	if rel == nil || !available {
		return s.Status(), ErrNotReady
	}
	ctx, engine, target, ok, err := s.claim()
	if err != nil || !ok {
		return s.Status(), err
	}
	go func() {
		defer s.unclaim()
		s.fetch(ctx, engine, target, rel)
	}()
	return s.Status(), nil
}

// claim takes the updater for one check or download, so two of them never
// run at once. It returns ErrOff when this copy can't update itself, and ok
// = false when something else is running or the update is already ready.
func (s *Service) claim() (ctx context.Context, engine Engine, target string, ok bool, err error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.engine == nil || s.ctx == nil {
		return nil, nil, "", false, ErrOff
	}
	if s.running || s.status.State == Ready {
		return nil, nil, "", false, nil
	}
	s.running = true
	return s.ctx, s.engine, s.target, true, nil
}

func (s *Service) unclaim() {
	s.mu.Lock()
	s.running = false
	s.mu.Unlock()
}

// run checks and, when the feed names a release, downloads it: what the
// background check does when the device's settings let it.
func (s *Service) run() {
	ctx, engine, target, ok, err := s.claim()
	if err != nil || !ok {
		return
	}
	defer s.unclaim()
	rel, found := s.look(ctx, engine)
	if !found || rel == nil {
		return
	}
	s.fetch(ctx, engine, target, rel)
}

// look asks the feed for a release. It says it's checking, then that Peli is
// up to date, or fails. When it finds one it names it and leaves the status
// on Checking, for its caller to say what happens next: Downloading, or
// Available with a question for the user. The second result is false when
// the check failed.
func (s *Service) look(ctx context.Context, engine Engine) (*updater.Release, bool) {
	s.set(func(st *Status) { st.State, st.Problem = Checking, "" })
	rel, err := engine.Check(ctx)
	if err != nil {
		s.fail(ctx, "check", err)
		return nil, false
	}
	checked := s.now()
	s.mu.Lock()
	s.next = checked.Add(CheckEvery)
	s.release = rel
	s.mu.Unlock()
	if rel == nil {
		s.set(func(st *Status) {
			*st = Status{State: UpToDate, Current: s.version, CheckedAt: checked.UnixMilli()}
		})
		return nil, true
	}
	s.put(func(st *Status) {
		st.Current, st.Version, st.Notes = s.version, rel.Version, rel.Notes
		st.Total, st.CheckedAt = rel.Artifact.Size, checked.UnixMilli()
	})
	return rel, true
}

// fetch downloads rel, checks the download and says it's ready.
func (s *Service) fetch(ctx context.Context, engine Engine, target string, rel *updater.Release) {
	s.set(func(st *Status) { st.State, st.Written = Downloading, 0 })
	if err := engine.DownloadAndInstall(ctx); err != nil {
		s.fail(ctx, "download", err)
		return
	}
	staged := engine.DownloadedPath()
	if err := s.installed.Check(staged, target, rel.Version); err != nil {
		discard(staged)
		s.fail(ctx, "check the download", err)
		return
	}
	s.set(func(st *Status) { st.State, st.Written = Ready, st.Total })
}

func (s *Service) fail(ctx context.Context, step string, err error) {
	if ctx.Err() != nil {
		return // shutting down
	}
	log.Printf("updates: %s: %v", step, err)
	s.mu.Lock()
	s.next = s.now().Add(RetryAfter)
	s.mu.Unlock()
	s.set(func(st *Status) {
		st.State, st.Problem, st.Written = Failed, problem(step, err), 0
	})
}

// problem is the error for Settings to show, in a sentence.
func problem(step string, err error) string {
	switch {
	case errors.Is(err, ErrUnsigned), errors.Is(err, ErrMismatch),
		strings.Contains(err.Error(), "signature"), strings.Contains(err.Error(), "digest"):
		return "The update didn’t pass Peli’s checks, so it wasn’t installed."
	case step == "check":
		return "Couldn’t reach the update server."
	default:
		return "The update didn’t download."
	}
}

// discard removes a download that failed its checks. Wails stages it in a
// folder of its own under the temporary folder.
func discard(staged string) {
	dir := filepath.Dir(staged)
	if staged != "" && strings.HasPrefix(filepath.Base(dir), "wails-update-") {
		_ = os.RemoveAll(dir)
	}
}

func (s *Service) progress(written, total int64) {
	s.mu.Lock()
	downloading := s.status.State == Downloading
	s.mu.Unlock()
	if downloading {
		s.set(func(st *Status) {
			st.Written = written
			if total > 0 {
				st.Total = total
			}
		})
	}
}

// Restart quits and opens the new version, for "Restart to update". It
// refuses while something is playing.
func (s *Service) Restart() error {
	s.mu.Lock()
	ready, engine := s.status.State == Ready, s.engine
	s.mu.Unlock()
	if !ready || engine == nil {
		return ErrNotReady
	}
	if s.playing != nil && s.playing() {
		return ErrPlaying
	}
	return engine.Restart(context.Background())
}

func (s *Service) set(change func(*Status)) {
	s.mu.Lock()
	change(&s.status)
	st := s.status
	s.mu.Unlock()
	s.emit(st)
}

// put changes the status without telling the frontend: for the release a
// check found, which the event right after says along with the state it
// settles on.
func (s *Service) put(change func(*Status)) {
	s.mu.Lock()
	change(&s.status)
	s.mu.Unlock()
}
