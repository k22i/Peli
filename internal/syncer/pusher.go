package syncer

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math/rand/v2"
	"sync"
	"time"

	"github.com/k22i/Sinag/internal/backend"
	"github.com/k22i/Sinag/internal/store"
)

// The push loop's timings (#30, ADR-0017).
const (
	// Debounce is how long the loop waits after a change for the next one,
	// so a burst of edits is one request, and MaxWait how long a steady
	// stream of changes can keep it waiting.
	Debounce = 2 * time.Second
	MaxWait  = 10 * time.Second
	// ProgressEvery is the least time between two pushes of one progress
	// entry while it is playing. The server ignores an update unless the
	// position moved 15 s or last_watched is 30 s newer (a 200 all the
	// same), so a push more often than that is only noise.
	ProgressEvery = 30 * time.Second
	// WatchedGrace is how long a watched push waits behind the finished
	// progress that makes the server create the same item: its own update
	// interval is 60 s.
	WatchedGrace = 75 * time.Second
	// Retries start at BackoffMin and double up to BackoffMax.
	BackoffMin = 5 * time.Second
	BackoffMax = 5 * time.Minute
	// KickGap is the least time between two attempts made on a launch or a
	// window focus, which ignore the backoff.
	KickGap = 10 * time.Second
	// A progress entry the server turns into a watched item: at least 90 % of
	// at least a minute.
	watchedMinDuration = 60_000
)

// mode is why a flush runs.
type mode int

const (
	// auto: a timer. It keeps the backoff, the progress interval and the
	// watched grace.
	auto mode = iota
	// kick: the launch or a window focus. Ignores the backoff.
	kick
	// force: a sign-out. Sends everything now.
	force
	// prompt: the player pausing, seeking or stopping (#64), the app
	// exiting. Sends everything now, except that a watched item still waits
	// behind the finished progress the server turns into the same item: the
	// outbox outlives both, so it can wait.
	prompt
	// resume: the network came back (#31). Forgets the backoff, otherwise
	// auto.
	resume
)

// Pusher sends the profiles' outboxes to their backends: after a short
// debounce when something is queued, progress at most every ProgressEvery,
// and everything at once when asked (pause, stop, exit, sign-out). A failed
// push is retried with backoff, and the outbox is the store's, so what is
// pending survives a restart. It is plain Go; Service wraps it for Wails.
type Pusher struct {
	open   func() *store.Store
	linked backend.Backend
	now    func() time.Time
	// Called before a deferred watched push is sent, so the pull can bring the
	// server's own copy (which settles the push); Puller.Pull in the app.
	refresh func(context.Context)
	// Called with the result of every push to Nuvio (Monitor.observe).
	observe func(error)

	debounce, maxWait, progressEvery, grace, backoffMin, backoffMax, kickGap time.Duration

	// One flush at a time.
	flushMu sync.Mutex

	mu    sync.Mutex
	ctx   context.Context // timers flush with it
	timer *time.Timer
	due   time.Time
	// The first change not yet flushed, and when to flush for the debounce;
	// when to flush for a progress or watched push that is waiting; and
	// when the backoff ends.
	first, debounceAt, wakeAt, retryAt time.Time
	failures                           int
	lastAttempt                        time.Time
	stopped                            bool
	// When each progress entry and each finished one's watched item was last
	// pushed, by profile and key.
	sentProgress map[sentKey]time.Time
	sentFinished map[sentKey]time.Time
}

// pushID names a queued push, as comparable (a Push holds a slice).
type pushID struct {
	surface store.Surface
	key     string
	seq     uint64
}

func idOf(push store.Push) pushID { return pushID{push.Surface, push.Key, push.Seq} }

type sentKey struct {
	profile uint64
	key     string
}

// NewPusher returns a pusher for open's store, sending linked profiles to
// linked.
func NewPusher(open func() *store.Store, linked backend.Backend) *Pusher {
	return &Pusher{
		open: open, linked: linked, now: time.Now, ctx: context.Background(), observe: func(error) {},
		debounce: Debounce, maxWait: MaxWait, progressEvery: ProgressEvery, grace: WatchedGrace,
		backoffMin: BackoffMin, backoffMax: BackoffMax, kickGap: KickGap,
		sentProgress: map[sentKey]time.Time{}, sentFinished: map[sentKey]time.Time{},
	}
}

// Notify is for the store: something was queued for profileID. It schedules a
// flush and returns at once.
func (p *Pusher) Notify(uint64) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.stopped {
		return
	}
	now := p.now()
	if p.first.IsZero() {
		p.first = now
	}
	p.debounceAt = earliest(now.Add(p.debounce), p.first.Add(p.maxWait))
	p.reschedule()
}

// Start has timer-driven flushes run with ctx.
func (p *Pusher) Start(ctx context.Context) {
	p.mu.Lock()
	p.ctx, p.stopped = ctx, false
	p.mu.Unlock()
	p.Background(ctx)
}

// Stop cancels the timer. Notify does nothing afterwards.
func (p *Pusher) Stop() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.stopped = true
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
	}
}

// reschedule arms the timer for the earliest thing waiting, not before the
// backoff ends. Call with p.mu held.
func (p *Pusher) reschedule() {
	at := earliest(p.debounceAt, p.wakeAt)
	if at.IsZero() {
		if p.timer != nil {
			p.timer.Stop()
			p.timer, p.due = nil, time.Time{}
		}
		return
	}
	if at.Before(p.retryAt) {
		at = p.retryAt
	}
	if p.timer != nil && p.due.Equal(at) {
		return
	}
	if p.timer != nil {
		p.timer.Stop()
	}
	ctx := p.ctx
	p.due = at
	p.timer = time.AfterFunc(max(at.Sub(p.now()), 0), func() {
		if err := p.flush(ctx, auto); err != nil {
			logPushError(err)
		}
	})
}

// Background flushes in a goroutine, for events with nobody to report an
// error to: the launch and a window getting focus. It ignores the backoff.
func (p *Pusher) Background(ctx context.Context) {
	go func() {
		if err := p.flush(ctx, kick); err != nil {
			logPushError(err)
		}
	}()
}

// Resume is for the network coming back (#31): it forgets the backoff and
// sends what is ready, keeping the progress interval and the watched grace.
func (p *Pusher) Resume(ctx context.Context) error { return p.flush(ctx, resume) }

// Flush sends everything queued now, for a sign-out. It returns what
// stopped it, if anything: the pushes that failed stay queued.
func (p *Pusher) Flush(ctx context.Context) error { return p.flush(ctx, force) }

// FlushProgress sends what is queued now, for the player pausing, seeking or
// stopping and for the app exiting, as Flush does, but leaves a watched item
// waiting out WatchedGrace behind its finished progress, so the server's own
// copy settles it rather than a second push (#64).
func (p *Pusher) FlushProgress(ctx context.Context) error { return p.flush(ctx, prompt) }

func logPushError(err error) {
	if !backend.Offline(err) && !errors.Is(err, context.Canceled) {
		slog.Warn("syncer: push failed", "error", err)
	}
}

func (p *Pusher) flush(ctx context.Context, m mode) error {
	p.flushMu.Lock()
	defer p.flushMu.Unlock()
	db := p.open()
	if db == nil {
		return nil
	}

	p.mu.Lock()
	now := p.now()
	if m == resume {
		// Under flushMu, so a flush that failed while offline and finished
		// just now can't put the backoff back.
		p.failures, p.retryAt = 0, time.Time{}
	}
	switch {
	case m == auto && now.Before(p.retryAt):
		p.reschedule()
		p.mu.Unlock()
		return nil
	case m == kick && now.Sub(p.lastAttempt) < p.kickGap:
		p.mu.Unlock()
		return nil
	}
	p.lastAttempt = now
	p.first, p.debounceAt, p.wakeAt = time.Time{}, time.Time{}, time.Time{}
	p.mu.Unlock()

	profiles, err := db.Profiles()
	if err != nil {
		return err
	}
	var errs []error
	var wake time.Time
	for _, profile := range profiles {
		w, err := p.flushProfile(ctx, db, profile, m)
		wake = earliest(wake, w)
		if err != nil {
			errs = append(errs, err)
			if backend.Down(err) || ctx.Err() != nil {
				break
			}
		}
	}
	err = errors.Join(errs...)

	p.mu.Lock()
	defer p.mu.Unlock()
	if err != nil && ctx.Err() == nil {
		p.failures++
		p.retryAt = p.now().Add(p.backoff(p.failures))
		wake = earliest(wake, p.retryAt)
	} else if err == nil {
		p.failures, p.retryAt = 0, time.Time{}
	}
	p.wakeAt = earliest(p.wakeAt, wake)
	if !p.stopped {
		p.reschedule()
	}
	return err
}

// backoff is how long to wait after the n-th failure in a row: doubling
// from backoffMin to backoffMax, with up to a fifth shaved off so devices
// that failed together don't retry together.
func (p *Pusher) backoff(n int) time.Duration {
	d := p.backoffMin
	for i := 1; i < n && d < p.backoffMax; i++ {
		d *= 2
	}
	d = min(d, p.backoffMax)
	return d - rand.N(d/5+1)
}

// flushProfile sends what is ready in profile's outbox and returns when the
// rest is due.
func (p *Pusher) flushProfile(ctx context.Context, db *store.Store, profile store.Profile, m mode) (wake time.Time, err error) {
	pending, err := db.Pending(profile.ID)
	if err != nil || len(pending) == 0 {
		return time.Time{}, err
	}
	ready, drop, wake := p.ready(profile, pending, m)
	if m != force && p.refresh != nil && p.waitingOnServer(profile, pending) {
		// A watched push has waited out its grace: the server's copy may be
		// here by now, and a pull settles the push.
		p.refresh(ctx)
		if pending, err = db.Pending(profile.ID); err != nil {
			return wake, err
		}
		ready, drop, wake = p.ready(profile, pending, m)
	}
	for _, push := range drop {
		if err := db.AckPush(profile.ID, push); err != nil && !errors.Is(err, store.ErrProfileNotFound) {
			return wake, err
		}
	}
	if len(ready) == 0 {
		return wake, nil
	}

	source := backend.For(profile, p.linked)
	acked, pushErr := source.Push(ctx, profile, ready)
	if profile.NuvioIndex != nil {
		p.observe(pushErr)
	}
	now := p.now()
	var errs []error
	isAcked := map[pushID]bool{}
	for _, push := range acked {
		isAcked[idOf(push)] = true
		if err := db.AckPush(profile.ID, push); err != nil && !errors.Is(err, store.ErrProfileNotFound) {
			errs = append(errs, err)
		}
		p.sent(profile, push, now)
	}
	if pushErr != nil {
		for _, push := range ready {
			if !isAcked[idOf(push)] {
				if err := db.FailPush(profile.ID, push, pushErr); err != nil && !errors.Is(err, store.ErrProfileNotFound) {
					errs = append(errs, err)
				}
			}
		}
		errs = append(errs, pushErr)
	}
	return wake, errors.Join(errs...)
}

// ready picks the pushes to send now, the ones to drop because Nuvio has no
// call for them, and when the first of the rest is due.
func (p *Pusher) ready(profile store.Profile, pending []store.Push, m mode) (ready, drop []store.Push, wake time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	var watched []store.Push
	finishing := map[string]bool{} // watched keys of finished progress going out now
	for _, push := range pending {
		switch {
		case !backend.Syncs(push.Surface):
			// Nothing the store queues today; a push of a new surface
			// waits for its call rather than being retried forever.
			slog.Warn("syncer: dropping a push Nuvio doesn't take", "surface", push.Surface, "key", push.Key)
			drop = append(drop, push)
		case push.Surface == store.SurfaceWatched && push.Op == store.OpUpsert:
			watched = append(watched, push)
		default:
			if push.Surface == store.SurfaceProgress && push.Op == store.OpUpsert && m != force && m != prompt {
				if sent, ok := p.sentProgress[sentKey{profile.ID, push.Key}]; ok && now.Sub(sent) < p.progressEvery {
					wake = earliest(wake, sent.Add(p.progressEvery))
					continue
				}
			}
			ready = append(ready, push)
			if key, ok := finishedWatchedKey(push); ok {
				finishing[key] = true
			}
		}
	}
	for _, push := range watched {
		if m != force {
			// The server makes this item itself once the finished progress
			// reaches it, so wait for that rather than repeat it.
			if sent, ok := p.sentFinished[sentKey{profile.ID, push.Key}]; ok && now.Sub(sent) < p.grace {
				wake = earliest(wake, sent.Add(p.grace))
				continue
			}
			if finishing[push.Key] {
				wake = earliest(wake, now.Add(p.grace))
				continue
			}
		}
		ready = append(ready, push)
	}
	return ready, drop, wake
}

// waitingOnServer is whether a watched push is queued whose grace has run
// out, so pulling first is worthwhile.
func (p *Pusher) waitingOnServer(profile store.Profile, pending []store.Push) bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now := p.now()
	for _, push := range pending {
		if push.Surface != store.SurfaceWatched || push.Op != store.OpUpsert {
			continue
		}
		if sent, ok := p.sentFinished[sentKey{profile.ID, push.Key}]; ok && now.Sub(sent) >= p.grace {
			return true
		}
	}
	return false
}

// sent records that push reached the backend.
func (p *Pusher) sent(profile store.Profile, push store.Push, now time.Time) {
	p.mu.Lock()
	defer p.mu.Unlock()
	for k, at := range p.sentProgress {
		if now.Sub(at) >= p.progressEvery {
			delete(p.sentProgress, k)
		}
	}
	for k, at := range p.sentFinished {
		if now.Sub(at) >= p.grace {
			delete(p.sentFinished, k)
		}
	}
	switch {
	case push.Surface == store.SurfaceProgress && push.Op == store.OpUpsert:
		p.sentProgress[sentKey{profile.ID, push.Key}] = now
		if key, ok := finishedWatchedKey(push); ok {
			p.sentFinished[sentKey{profile.ID, key}] = now
		}
	case push.Surface == store.SurfaceWatched:
		delete(p.sentFinished, sentKey{profile.ID, push.Key})
	}
}

// finishedWatchedKey returns the key of the watched item the server makes
// when it gets push, if push is a progress upsert at 90 % or more of an item
// of a minute or more.
func finishedWatchedKey(push store.Push) (string, bool) {
	if push.Surface != store.SurfaceProgress || push.Op != store.OpUpsert {
		return "", false
	}
	var entry store.Progress
	if json.Unmarshal(push.Item, &entry) != nil || entry.Duration < watchedMinDuration || entry.Position*10 < entry.Duration*9 {
		return "", false
	}
	item, err := json.Marshal(store.WatchedItem{ContentID: entry.ContentID, ContentType: entry.ContentType, Season: entry.Season, Episode: entry.Episode})
	if err != nil {
		return "", false
	}
	key, err := store.PushKey(store.SurfaceWatched, item)
	return key, err == nil
}

// earliest is the earlier of two times, where the zero time means none.
func earliest(a, b time.Time) time.Time {
	if a.IsZero() {
		return b
	}
	if b.IsZero() || a.Before(b) {
		return a
	}
	return b
}
