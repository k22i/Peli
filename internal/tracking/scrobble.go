package tracking

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"math"
	"sync"
	"time"

	"github.com/k22i/Sinag/internal/anilist"
	"github.com/k22i/Sinag/internal/player"
	"github.com/k22i/Sinag/internal/simkl"
	"github.com/k22i/Sinag/internal/store"
)

// Scrobbling (#73) and AniList progress (#105), from the player's reports.
//
// SIMKL wants one call per thing the user does, never a heartbeat: start
// when a file starts or plays again after a pause, pause on pause, stop when
// it ends or is left. Seeks send nothing; the next call carries the
// position. A stop at 90 % or more marks it watched: min_progress makes
// SIMKL use Nuvio's 90 % instead of its own 80 % (ADR-0042), so both agree
// on what's watched.
//
// AniList has no playback: when an episode reaches Nuvio's watched point
// (90 % of at least a minute), its entry's progress becomes that episode.

// watchedShare and watchedMinDuration are Nuvio's watched rule
// (internal/watching).
const (
	watchedShare       = 0.9
	watchedMinDuration = 60 // s
	minProgress        = 90
)

// callTimeout bounds one call to SIMKL or AniList.
const callTimeout = 20 * time.Second

// scrobbler turns reports into calls, one at a time, on its own goroutine.
type scrobbler struct {
	s       *Service
	reports chan player.Report
	kick    chan struct{}

	// Of the file playing: which it is, whether SIMKL was last told it
	// plays, and whether AniList was updated for it.
	key     string
	playing bool
	updated bool

	// busy counts reports not yet handled, for drain.
	mu   sync.Mutex
	busy int
	idle *sync.Cond
}

func newScrobbler(s *Service) *scrobbler {
	sc := &scrobbler{s: s, reports: make(chan player.Report, 64), kick: make(chan struct{}, 1)}
	sc.idle = sync.NewCond(&sc.mu)
	return sc
}

// report queues r without waiting; when the queue is full (SIMKL is slow
// and the player busy) periodic reports are dropped first.
func (sc *scrobbler) report(r player.Report) {
	sc.mu.Lock()
	sc.busy++
	sc.mu.Unlock()
	select {
	case sc.reports <- r:
	default:
		if r.Why != player.ReportPlaying {
			go func() { sc.reports <- r }()
			return
		}
		sc.done()
	}
}

func (sc *scrobbler) done() {
	sc.mu.Lock()
	sc.busy--
	if sc.busy == 0 {
		sc.idle.Broadcast()
	}
	sc.mu.Unlock()
}

// drain waits up to d for the reports queued to be handled.
func (sc *scrobbler) drain(d time.Duration) {
	finished := make(chan struct{})
	go func() {
		sc.mu.Lock()
		for sc.busy > 0 {
			sc.idle.Wait()
		}
		sc.mu.Unlock()
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(d):
	}
}

// run handles reports, and sends kept jobs when they're due.
func (sc *scrobbler) run(ctx context.Context) {
	retry := time.NewTimer(time.Minute)
	defer retry.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case r := <-sc.reports:
			sc.handle(ctx, r)
			sc.done()
		case <-sc.kick:
		case <-retry.C:
		}
		next := sc.s.sendJobs(ctx)
		retry.Reset(next)
	}
}

func (sc *scrobbler) handle(ctx context.Context, r player.Report) {
	w := r.Watching
	if r.Duration <= 0 || math.IsNaN(r.Position) {
		return
	}
	db := sc.s.open()
	if db == nil {
		return
	}
	key := sessionKey(w)
	if key != sc.key {
		sc.key, sc.playing, sc.updated = key, false, false
	}
	progress := 100 * r.Position / r.Duration
	finished := r.Duration >= watchedMinDuration && r.Position >= r.Duration*watchedShare

	var action string
	switch r.Why {
	case player.ReportStarted, player.ReportResumed:
		action = simkl.ActionStart
	case player.ReportPlaying, player.ReportSeeked:
		// Missed a resume (the pause and play came together): say it plays.
		if !sc.playing {
			action = simkl.ActionStart
		}
	case player.ReportPaused:
		action = simkl.ActionPause
	case player.ReportEnded, player.ReportStopped:
		action = simkl.ActionStop
	}
	t, err := db.Tracking(w.ProfileID)
	if err != nil {
		return
	}
	settings := sc.s.settings(db, w.ProfileID)
	if action != "" && t.Simkl != nil && settings.SimklScrobble && (settings.SimklAnime || !sc.s.isAnime(ctx, w)) {
		sc.scrobble(ctx, w, action, progress, finished)
	}
	switch action {
	case simkl.ActionStart:
		sc.playing = true
	case simkl.ActionPause:
		sc.playing = false
	case simkl.ActionStop:
		sc.key, sc.playing = "", false
	}
	if finished && !sc.updated && t.AniList != nil && settings.AniListProgress {
		sc.updated = true
		sc.s.updateAniList(ctx, w)
	}
}

// sessionKey names the file being played, so a report for another one
// starts afresh.
func sessionKey(w player.Watching) string {
	data, _ := json.Marshal([]any{w.ProfileID, w.ContentID, w.VideoID, w.Season, w.Episode})
	return string(data)
}

func (sc *scrobbler) scrobble(ctx context.Context, w player.Watching, action string, progress float64, finished bool) {
	item, ok := simklItem(w)
	if !ok {
		return
	}
	call, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	err := sc.s.withSimkl(call, w.ProfileID, func(token string) error {
		_, err := sc.s.simkl.Scrobble(call, token, action, item, progress, minProgress)
		return err
	})
	switch {
	case err == nil, errors.Is(err, simkl.ErrAlreadyDone):
		// A 409 on a stop: SIMKL finalized the session already.
	case errors.Is(err, simkl.ErrNotFound):
		slog.Info("tracking: SIMKL doesn't know the title", "content", w.ContentID)
	case action == simkl.ActionStop && finished && (simkl.Temporary(err) || errors.Is(err, context.DeadlineExceeded)):
		// Offline, or SIMKL busy: the watch is kept and sent to the
		// history when it can be, at the time it happened. A start or a
		// pause only says what plays now, so it isn't kept.
		sc.s.queue(w.ProfileID, ServiceSimkl, simklJob{Item: item, WatchedAt: sc.s.now().UTC().Format(time.RFC3339)})
	case errors.Is(err, ErrNotConnected):
	default:
		slog.Warn("tracking: SIMKL scrobble failed", "action", action, "error", err)
	}
}

// updateAniList sets the AniList entry w is in to w's episode, if it's
// further than the list has it.
func (s *Service) updateAniList(ctx context.Context, w player.Watching) {
	job, ok := s.aniListJob(ctx, w)
	if !ok {
		return
	}
	call, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	err := s.sendAniList(call, w.ProfileID, job)
	switch {
	case err == nil, errors.Is(err, ErrNotConnected):
	case anilist.Temporary(err) || errors.Is(err, context.DeadlineExceeded):
		s.queue(w.ProfileID, ServiceAniList, job)
	default:
		slog.Warn("tracking: AniList update failed", "error", err)
	}
}

// aniListJob finds the AniList entry and episode w is, through the anime
// list, or AniList itself for a MyAnimeList id the list doesn't have.
func (s *Service) aniListJob(ctx context.Context, w player.Watching) (aniListJob, bool) {
	ref := aniListRef(w)
	if s.anime != nil {
		if entry, episode, ok := s.anime.Find(ctx, ref); ok {
			return aniListJob{Media: entry.AniList, Episode: episode}, true
		}
	}
	if ref.AniList != 0 {
		return aniListJob{Media: ref.AniList, Episode: max(ref.Episode, 1)}, true
	}
	if ref.MAL != 0 {
		call, cancel := context.WithTimeout(ctx, callTimeout)
		defer cancel()
		if media, err := s.anilist.ByMAL(call, ref.MAL); err == nil {
			return aniListJob{Media: media.ID, Episode: max(ref.Episode, 1)}, true
		}
	}
	return aniListJob{}, false
}

// sendAniList sends job: a list or score change, or else moves the entry's progress up to job's episode: Completed at
// the last episode (or a film), Current before it. An entry already as far
// is left as it is, and so is one being rewatched, but for its progress.
func (s *Service) sendAniList(ctx context.Context, profileID uint64, job aniListJob) error {
	if job.Op != "" {
		return s.changeAniList(ctx, profileID, job)
	}
	return s.withAniList(ctx, profileID, func(_ store.AniListLink, token string) error {
		media, err := s.anilist.WithEntry(ctx, token, job.Media)
		if err != nil {
			return err
		}
		episode := job.Episode
		if media.Format == "MOVIE" {
			episode = 1
		}
		if media.Episodes != nil && *media.Episodes > 0 {
			episode = min(episode, *media.Episodes)
		}
		status := anilist.StatusCurrent
		if media.Entry != nil {
			if media.Entry.Progress >= episode && media.Entry.Status != anilist.StatusRepeating {
				return nil
			}
			if media.Entry.Status == anilist.StatusRepeating {
				status = anilist.StatusRepeating
			}
		}
		if media.Format == "MOVIE" || media.Episodes != nil && episode >= *media.Episodes {
			status = anilist.StatusCompleted
		}
		return s.anilist.SaveProgress(ctx, token, job.Media, episode, status)
	})
}
