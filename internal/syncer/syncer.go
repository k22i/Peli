// Package syncer keeps the profile in use up to date with Nuvio (#29): it
// pulls the library, progress and watched feeds by delta cursor when the app
// launches, when its window gets focus, when the profile changes and every
// few minutes, merges them into the local store and tells the frontend what
// changed so it can refresh its caches. Pushing is pusher.go (#30), addons
// are #32's.
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
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Sinag/internal/backend"
	"github.com/k22i/Sinag/internal/store"
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
)

// surfaces are the feeds the pull reads. Addons have no delta feed and
// belong to #32.
var surfaces = []store.Surface{store.SurfaceLibrary, store.SurfaceProgress, store.SurfaceWatched}

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
	now  func() time.Time

	// One pull at a time, and when each profile was last pulled.
	mu   sync.Mutex
	last map[uint64]time.Time
}

// NewPuller returns a puller that reads from open's store and, for a profile
// linked to Nuvio, from linked.
func NewPuller(open func() *store.Store, linked backend.Backend) *Puller {
	return &Puller{open: open, linked: linked, emit: func(Pulled) {}, now: time.Now, last: map[uint64]time.Time{}}
}

// Pull pulls the profile in use, unless it was pulled less than MinGap ago
// (then it does nothing) or isn't linked to Nuvio, such as the Guest, which
// makes no request at all (#23). It returns what changed. If one feed fails
// the others are still pulled, and the first error comes back; an error that
// would hit every feed (signed out, unreachable) stops the pull at once.
func (p *Puller) Pull(ctx context.Context) (Pulled, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	db := p.open()
	if db == nil {
		return Pulled{}, nil
	}
	profile, ok, err := db.ProfileInUse()
	if err != nil || !ok || profile.NuvioIndex == nil {
		return Pulled{}, err
	}
	if at, ok := p.last[profile.ID]; ok && p.now().Sub(at) < MinGap {
		return Pulled{ProfileID: profile.ID}, nil
	}
	p.last[profile.ID] = p.now()

	pulled, err := p.pull(ctx, db, profile)
	if len(pulled.Surfaces) > 0 {
		p.emit(pulled)
	}
	if errors.Is(err, store.ErrProfileNotFound) {
		// Signed out, or the profile deleted, while the pull was running.
		delete(p.last, profile.ID)
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
	go func() {
		if _, err := p.Pull(ctx); err != nil && !backend.Offline(err) && !errors.Is(err, context.Canceled) {
			slog.Warn("syncer: pull failed", "error", err)
		}
	}()
}

// ShutdownFlush is how long the app waits at exit to send what is queued.
const ShutdownFlush = 5 * time.Second

// Service is the Wails service for syncing. It polls while the app is open;
// the launch and window focus are main's, through PullerOf and PusherOf, and
// the frontend asks for a pull when the profile in use changes and for a
// flush when playback pauses or stops. Pushes follow every change by
// themselves, through the store's OnQueued.
type Service struct {
	db     *store.Service
	puller *Puller
	pusher *Pusher
	stop   context.CancelFunc
}

// NewService returns a service that syncs db's profile in use with linked.
func NewService(db *store.Service, linked backend.Backend) *Service {
	open := func() *store.Store { return store.Opened(db) }
	s := &Service{db: db, puller: NewPuller(open, linked), pusher: NewPusher(open, linked)}
	s.pusher.refresh = func(ctx context.Context) { s.puller.Pull(ctx) }
	store.NotifyQueued(db, s.pusher.Notify)
	return s
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
	}
	ctx, s.stop = context.WithCancel(context.WithoutCancel(ctx))
	s.pusher.Start(ctx)
	go func() {
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
	}()
	return nil
}

// ServiceShutdown sends what is queued before the app exits, for up to
// ShutdownFlush. Services shut down in reverse order, so the store is still
// open.
func (s *Service) ServiceShutdown() error {
	s.pusher.Stop()
	ctx, cancel := context.WithTimeout(context.Background(), ShutdownFlush)
	defer cancel()
	if err := s.pusher.Flush(ctx); err != nil {
		logPushError(err)
	}
	if s.stop != nil {
		s.stop()
	}
	return nil
}

// Flush pushes everything queued now, for when playback pauses or stops: the
// loop pushes progress at most every 30 s while it plays, so the position
// where it stopped goes out at once. It returns the error that stopped the
// push, such as being offline; what failed stays queued and is retried.
func (s *Service) Flush(ctx context.Context) error { return s.pusher.Flush(ctx) }

// Pull pulls the profile in use now, for when the frontend has just switched
// to it or signed in. It does nothing if the profile was pulled in the last
// half minute.
func (s *Service) Pull(ctx context.Context) (Pulled, error) { return s.puller.Pull(ctx) }
