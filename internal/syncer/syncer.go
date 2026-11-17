// Package syncer keeps the profile in use up to date with Nuvio (#29): it
// pulls the library, progress and watched feeds by delta cursor when the app
// launches, when its window gets focus, when the profile changes and every
// few minutes, merges them into the local store and tells the frontend what
// changed so it can refresh its caches. It pulls the addon list too (#32),
// and the home layout and collections (#35).
// Pushing is pusher.go (#30), noticing the network go and come back is
// connection.go (#31).
//
// The wire is the sync module's (internal/backend, ADR-0015); this package
// decides when to pull and what to do with the answer. There is no realtime
// channel to subscribe to (docs/spikes/nuvio-backend.md), so polling the
// cursors is all there is.
package syncer

import (
	"context"
	"errors"
	"log/slog"
	"slices"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/backend"
	"github.com/k22i/Peli/internal/safego"
	"github.com/k22i/Peli/internal/store"
)

// EventPulled tells the frontend a pull changed the local store. Its data is
// a Pulled.
const EventPulled = "sync:pulled"

func init() {
	application.RegisterEvent[Pulled](EventPulled)
}

const (
	// PollEvery is how often the app pulls while it is open, on top of the
	// pull each time the window gets focus.
	PollEvery = 5 * time.Minute
	// MinGap is the least time between two pulls of one profile. A window
	// that is focused and unfocused in quick succession, or a profile
	// switched back and forth, doesn't make a request each time.
	MinGap = 30 * time.Second
	// ReconcileEvery is how often a profile's library, progress and watched
	// items are checked against the backend's whole lists, on top of the
	// delta feeds: at the first pull of each run, then at most this often
	//.
	ReconcileEvery = time.Hour
)

// surfaces are what the pull reads. Addons, plugin repositories (#57), the home layout and collections
// have no delta feed: each pull reads the whole of each (one small request)
// and the cursor never moves (#32, #35).
var surfaces = []store.Surface{
	store.SurfaceLibrary, store.SurfaceProgress, store.SurfaceWatched, store.SurfaceAddons, store.SurfacePlugins,
	store.SurfaceHomeLayout, store.SurfaceCollections,
}

// Pulled is what a pull changed in one profile: the surfaces where something
// was written, none if the local store was already up to date.
type Pulled struct {
	ProfileID uint64          `json:"profileId"`
	Surfaces  []store.Surface `json:"surfaces"`
}

// Puller pulls the profile in use from its backend. It is plain Go, so main
// can call it from window events; Service wraps it for the frontend.
type Puller struct {
	open   func() *store.Store
	linked backend.Backend
	// Called after a pull that wrote something.
	emit func(Pulled)
	// Called with the result of every pull that asked Nuvio (Monitor.observe).
	observe func(error)
	// Brings the profiles themselves in line with Nuvio before each pull
	// (account.RefreshProfiles); nil does nothing.
	refreshProfiles func(context.Context) error
	now             func() time.Time

	// One pull at a time, and when each profile was last pulled and last
	// reconciled.
	mu         sync.Mutex
	last       map[uint64]time.Time
	reconciled map[uint64]time.Time
	profilesAt time.Time
}

// RefreshProfilesWith has puller refresh the profiles with fn before each
// pull (at most every MinGap). It isn't a method of Service, so Wails
// doesn't bind it.
func RefreshProfilesWith(puller *Puller, fn func(context.Context) error) {
	puller.mu.Lock()
	defer puller.mu.Unlock()
	puller.refreshProfiles = fn
}

// NewPuller returns a puller that reads from open's store and, for a profile
// linked to Nuvio, from linked.
func NewPuller(open func() *store.Store, linked backend.Backend) *Puller {
	return &Puller{
		open: open, linked: linked, emit: func(Pulled) {}, observe: func(error) {}, now: time.Now,
		last: map[uint64]time.Time{}, reconciled: map[uint64]time.Time{},
	}
}

// Pull pulls the profile in use, unless it was pulled less than MinGap ago
// (then it does nothing) or isn't linked to Nuvio, such as the Guest, which
// makes no request at all (#23). It returns what changed. If one feed fails
// the others are still pulled, and the first error comes back; an error that
// would hit every feed (signed out, unreachable) stops the pull at once.
func (p *Puller) Pull(ctx context.Context) (Pulled, error) { return p.pullInUse(ctx, true) }

// PullNow pulls the profile in use even if it was pulled less than MinGap
// ago, for when the network has just come back (#31): what was pulled before
// it went may be the last thing that got through.
func (p *Puller) PullNow(ctx context.Context) (Pulled, error) { return p.pullInUse(ctx, false) }

func (p *Puller) pullInUse(ctx context.Context, throttle bool) (Pulled, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	db := p.open()
	if db == nil {
		return Pulled{}, nil
	}
	if p.refreshProfiles != nil && (!throttle || p.now().Sub(p.profilesAt) >= MinGap) {
		p.profilesAt = p.now()
		if err := p.refreshProfiles(ctx); err != nil && !backend.Offline(err) && ctx.Err() == nil {
			slog.Warn("syncer: refreshing profiles failed", "error", err)
		}
	}
	profile, ok, err := db.ProfileInUse()
	if err != nil || !ok || profile.NuvioIndex == nil {
		return Pulled{}, err
	}
	if at, ok := p.last[profile.ID]; ok && throttle && p.now().Sub(at) < MinGap {
		return Pulled{ProfileID: profile.ID}, nil
	}
	p.last[profile.ID] = p.now()

	pulled, err := p.pull(ctx, db, profile)
	if at, ok := p.reconciled[profile.ID]; err == nil && (!ok || p.now().Sub(at) >= ReconcileEvery) {
		var surfaces []store.Surface
		if surfaces, err = p.reconcile(ctx, db, profile); err == nil {
			p.reconciled[profile.ID] = p.now()
		}
		for _, surface := range surfaces {
			if !slices.Contains(pulled.Surfaces, surface) {
				pulled.Surfaces = append(pulled.Surfaces, surface)
			}
		}
	}
	p.observe(err)
	if len(pulled.Surfaces) > 0 {
		p.emit(pulled)
	}
	if errors.Is(err, store.ErrProfileNotFound) {
		// Signed out, or the profile deleted, while the pull was running.
		delete(p.last, profile.ID)
		delete(p.reconciled, profile.ID)
		err = nil
	}
	return pulled, err
}

// pull reads every feed of profile from its cursor and merges it into the
// store. The cursor moves only after the merge has committed, and merging is
// idempotent, so a pull that dies half way is repeated safely.
func (p *Puller) pull(ctx context.Context, db *store.Store, profile store.Profile) (Pulled, error) {
	pulled := Pulled{ProfileID: profile.ID, Surfaces: []store.Surface{}}
	source := backend.For(profile, p.linked)
	var errs []error
	for _, surface := range surfaces {
		cursor, ok, err := db.Cursor(profile.ID, surface)
		if err == nil {
			var changes []backend.Change
			var next int64
			if changes, next, err = source.Pull(ctx, profile, surface, cursor, ok); err == nil {
				var applied int
				if applied, err = apply(db, profile.ID, changes); err == nil {
					if applied > 0 {
						pulled.Surfaces = append(pulled.Surfaces, surface)
					}
					if !ok || next != cursor {
						err = db.SetCursor(profile.ID, surface, next)
					}
				}
			}
		}
		if err != nil {
			if backend.Down(err) || ctx.Err() != nil || errors.Is(err, store.ErrProfileNotFound) {
				return pulled, err
			}
			errs = append(errs, err)
		}
	}
	return pulled, errors.Join(errs...)
}

// reconcile makes profile's library, progress and watched items match the
// backend's whole lists, when the backend can read them (store.Reconcile).
// The delta feeds bring changes as they happen; this catches one the store
// once skipped and the cursor has gone past, such as Continue Watching
// entries removed on another device. A list the backend says may be
// cut short only adds and updates. It returns the surfaces it changed.
func (p *Puller) reconcile(ctx context.Context, db *store.Store, profile store.Profile) ([]store.Surface, error) {
	snapshotter, ok := backend.For(profile, p.linked).(backend.Snapshotter)
	if !ok {
		return nil, nil
	}
	var changed []store.Surface
	for _, surface := range backend.Snapshots {
		changes, complete, err := snapshotter.Snapshot(ctx, profile, surface)
		if err != nil {
			return changed, err
		}
		var n int
		if complete {
			n, err = db.Reconcile(profile.ID, surface, changes)
		} else {
			n, err = apply(db, profile.ID, changes)
		}
		if errors.Is(err, store.ErrInvalidItem) {
			// One bad row spoils the snapshot; the feeds carry on.
			slog.Warn("syncer: skipping a snapshot the store refused", "surface", surface, "error", err)
			continue
		}
		if err != nil {
			return changed, err
		}
		if n > 0 {
			changed = append(changed, surface)
		}
	}
	return changed, nil
}

// apply merges changes into profile id. If the store refuses a change as
// invalid, such as a row without a content ID, it applies the others one by
// one and drops that one, so a single bad row doesn't hold its feed's cursor
// back for good.
func apply(db *store.Store, id uint64, changes []backend.Change) (int, error) {
	applied, err := db.ApplyChanges(id, changes)
	if !errors.Is(err, store.ErrInvalidItem) {
		return applied, err
	}
	applied = 0
	for _, change := range changes {
		n, err := db.ApplyChanges(id, []backend.Change{change})
		if errors.Is(err, store.ErrInvalidItem) {
			slog.Warn("syncer: dropping a change the store refused", "surface", change.Surface, "key", change.Key, "error", err)
			continue
		}
		if err != nil {
			return applied, err
		}
		applied += n
	}
	return applied, nil
}

// Background pulls in a goroutine, for events with nobody to report an error
// to: the launch, a window getting focus, the poll.
func (p *Puller) Background(ctx context.Context) {
	safego.Go("syncer: pull", func() {
		if _, err := p.Pull(ctx); err != nil && !backend.Offline(err) && !errors.Is(err, context.Canceled) {
			slog.Warn("syncer: pull failed", "error", err)
		}
	})
}

// ShutdownFlush is how long the app waits at exit to send what is queued.
const ShutdownFlush = 5 * time.Second

// Service is the Wails service for syncing. It polls while the app is open;
// the launch and window focus are main's, through PullerOf and PusherOf, and
// the frontend asks for a pull when the profile in use changes and for a
// flush when playback pauses or stops. Pushes follow every change by
// themselves, through the store's OnQueued.
type Service struct {
	db      *store.Service
	puller  *Puller
	pusher  *Pusher
	monitor *Monitor
	stop    context.CancelFunc
}

// pinger is a backend that can check it is reachable without a session:
// backend.Nuvio.
type pinger interface {
	Ping(context.Context) error
}

// NewService returns a service that syncs db's profile in use with linked.
func NewService(db *store.Service, linked backend.Backend) *Service {
	open := func() *store.Store { return store.Opened(db) }
	s := &Service{db: db, puller: NewPuller(open, linked), pusher: NewPusher(open, linked)}
	ping := func(context.Context) error { return nil }
	if p, ok := linked.(pinger); ok {
		ping = p.Ping
	}
	s.monitor = NewMonitor(ping, s.reconnect)
	s.puller.observe, s.pusher.observe = s.monitor.observe, s.monitor.observe
	s.pusher.refresh = func(ctx context.Context) { s.puller.Pull(ctx) }
	store.NotifyQueued(db, s.pusher.Notify)
	return s
}

// reconnect is what happens when Nuvio can be reached again (#31): what was
// changed while offline goes out first, then the pull brings in what other
// devices changed, without waiting out the pull's throttle or the push's
// backoff.
func (s *Service) reconnect(ctx context.Context) {
	if ctx.Err() != nil {
		return
	}
	if err := s.pusher.Resume(ctx); err != nil {
		logPushError(err)
	}
	if _, err := s.puller.PullNow(ctx); err != nil && !backend.Offline(err) && !isCancelled(err) {
		slog.Warn("syncer: pull after reconnecting failed", "error", err)
	}
}

// PullerOf returns service's puller, for the launch and window events. It
// isn't a method, so Wails doesn't bind it.
func PullerOf(service *Service) *Puller { return service.puller }

// PusherOf returns service's pusher, for the launch and window events and the
// sign-out flush. It isn't a method, so Wails doesn't bind it.
func PusherOf(service *Service) *Pusher { return service.pusher }

// ServiceStartup starts polling and has the puller tell the frontend what it
// pulled.
func (s *Service) ServiceStartup(ctx context.Context, _ application.ServiceOptions) error {
	if app := application.Get(); app != nil {
		s.puller.emit = func(pulled Pulled) { app.Event.Emit(EventPulled, pulled) }
		s.monitor.emit = func(c Connection) { app.Event.Emit(EventConnection, c) }
	}
	ctx, s.stop = context.WithCancel(context.WithoutCancel(ctx))
	s.monitor.Start(ctx)
	s.pusher.Start(ctx)
	safego.Go("syncer: poll", func() {
		ticker := time.NewTicker(PollEvery)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.puller.Background(ctx)
			}
		}
	})
	return nil
}

// ServiceShutdown sends what is queued before the app exits, for up to
// ShutdownFlush. Services shut down in reverse order, so the store is still
// open.
func (s *Service) ServiceShutdown() error {
	s.monitor.Stop()
	s.pusher.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), ShutdownFlush)
	defer cancel()
	if err := s.pusher.FlushProgress(ctx); err != nil {
		logPushError(err)
	}
	if s.stop != nil {
		s.stop()
	}
	s.monitor.Wait()
	return nil
}

// Flush pushes what is queued now, as the player does itself when playback
// pauses, seeks or stops (#64): the loop pushes progress at most every 30 s
// while it plays, so the position where it stopped goes out at once. A
// watched item still waits for the server's own (Pusher.FlushProgress). It
// returns the error that stopped the push, such as being offline; what
// failed stays queued and is retried.
func (s *Service) Flush(ctx context.Context) error { return s.pusher.FlushProgress(ctx) }

// WakeOf checks the connection now if Nuvio wasn't reachable, for the app
// coming back from suspension (main_ios.go). It isn't a method, so Wails
// doesn't bind it.
func WakeOf(service *Service) { service.monitor.Wake() }

// Pull pulls the profile in use now, for when the frontend has just switched
// to it or signed in. It does nothing if the profile was pulled in the last
// half minute.
func (s *Service) Pull(ctx context.Context) (Pulled, error) { return s.puller.Pull(ctx) }

// Connection is whether Nuvio can be reached, as far as the app knows: from
// the last pull or push, or the last check while offline. The frontend shows
// an indicator when it isn't, and EventConnection tells it of a change.
func (s *Service) Connection() Connection { return s.monitor.Connection() }

// CheckConnection asks Nuvio now, if it wasn't reachable, and returns the
// connection; if it is back, what is queued is sent and the profile pulled.
// For the indicator's "Try again" and the webview's online event.
func (s *Service) CheckConnection(ctx context.Context) Connection { return s.monitor.Check(ctx) }
