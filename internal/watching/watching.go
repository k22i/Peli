// Package watching keeps how far a profile got in what the player plays
// (#64): each report from internal/player becomes the profile's progress in
// the store, a film or episode played to 90 % is marked watched, and a
// pause, seek, end or stop has the push loop send it now. See ADR-0039.
package watching

import (
	"context"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/k22i/Peli/internal/player"
	"github.com/k22i/Peli/internal/store"
)

// Nuvio's server marks an item watched once its progress reaches 90 % of at
// least a minute (M0 gate, #8). Peli marks it at the same point, so both
// agree on what is watched; the push loop holds Peli's mark back until the
// server has made its own (ADR-0017), so it isn't sent twice.
const (
	watchedShare       = 0.9
	watchedMinDuration = 60_000 // ms
)

// FlushTimeout bounds a push sent after a pause, seek, end or stop.
const FlushTimeout = 30 * time.Second

// Reporter turns the player's reports into progress and watched items.
type Reporter struct {
	open  func() *store.Store
	flush func(context.Context) error
	now   func() time.Time

	mu sync.Mutex
	// One push at a time, and one more if asked meanwhile.
	flushing, again bool
	idle            chan struct{}
}

// New returns a Reporter writing to open's store and pushing with flush
// (syncer's Pusher.Flush in the app).
func New(open func() *store.Store, flush func(context.Context) error) *Reporter {
	return &Reporter{open: open, flush: flush, now: time.Now}
}

// Report keeps r: the profile's progress in the film or episode, its watched
// mark at 90 %, and a push now unless it's a periodic report or playing
// starting again (the push loop sends those every 30 s by itself).
func (rep *Reporter) Report(r player.Report) {
	db := rep.open()
	w := r.Watching
	if db == nil || r.Duration <= 0 || math.IsNaN(r.Position) {
		return
	}
	now := rep.now().UnixMilli()
	entry := store.Progress{
		ContentID:   w.ContentID,
		ContentType: w.ContentType,
		VideoID:     w.VideoID,
		Season:      w.Season,
		Episode:     w.Episode,
		Position:    int64(math.Round(r.Position * 1000)),
		Duration:    int64(math.Round(r.Duration * 1000)),
		LastWatched: now,
	}
	if _, err := db.SaveProgress(w.ProfileID, entry); err != nil {
		slog.Warn("watching: progress not saved", "error", err)
		return
	}
	if finished(entry) {
		if err := markWatched(db, w, now); err != nil {
			slog.Warn("watching: not marked watched", "error", err)
		}
	}
	if r.Why != player.ReportPlaying && r.Why != player.ReportStarted && r.Why != player.ReportResumed {
		rep.push()
	}
}

func finished(entry store.Progress) bool {
	return entry.Duration >= watchedMinDuration &&
		float64(entry.Position) >= float64(entry.Duration)*watchedShare
}

// markWatched marks w watched unless it is already, so playing on past 90 %
// or watching it again queues nothing more.
func markWatched(db *store.Store, w player.Watching, now int64) error {
	marks, err := db.TitleWatched(w.ProfileID, w.ContentID)
	if err != nil {
		return err
	}
	for _, mark := range marks {
		if same(mark.Season, w.Season) && same(mark.Episode, w.Episode) {
			return nil
		}
	}
	return db.MarkWatched(w.ProfileID, store.WatchedItem{
		ContentID:   w.ContentID,
		ContentType: w.ContentType,
		Title:       w.Title,
		Season:      w.Season,
		Episode:     w.Episode,
		WatchedAt:   now,
	})
}

func same(a, b *int) bool { return (a == nil) == (b == nil) && (a == nil || *a == *b) }

// push has the push loop send what is queued, in the background: Report runs
// on the player's goroutine. Pushes asked for while one is out (a burst of
// seeks) become one more.
func (rep *Reporter) push() {
	rep.mu.Lock()
	defer rep.mu.Unlock()
	if rep.flushing {
		rep.again = true
		return
	}
	rep.flushing, rep.idle = true, make(chan struct{})
	go func() {
		for {
			ctx, cancel := context.WithTimeout(context.Background(), FlushTimeout)
			// Offline or signed out: the push loop keeps it and retries.
			_ = rep.flush(ctx)
			cancel()
			rep.mu.Lock()
			if !rep.again {
				rep.flushing = false
				close(rep.idle)
				rep.mu.Unlock()
				return
			}
			rep.again = false
			rep.mu.Unlock()
		}
	}()
}

// wait returns once no push is out, for tests.
func (rep *Reporter) wait() {
	rep.mu.Lock()
	idle := rep.idle
	rep.mu.Unlock()
	if idle != nil {
		<-idle
	}
}
