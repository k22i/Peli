package tracking

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"time"

	"github.com/k22i/Peli/internal/anilist"
	"github.com/k22i/Peli/internal/simkl"
	"github.com/k22i/Peli/internal/store"
)

// The offline queue (#73, #105): a watch SIMKL or AniList couldn't be told
// about is kept in the store, so it survives quitting, and sent again with
// backoff. A watched film or episode goes to SIMKL's history with the time
// it was watched, rather than as a late stop.

// simklJob is a watch for SIMKL's history.
//
// Op says what else the job is, for the list and rating changes the user
// makes (actions.go); the empty Op is a watch.
type simklJob struct {
	Item      simkl.Item `json:"item"`
	WatchedAt string     `json:"watchedAt"`

	Op     string       `json:"op,omitempty"`
	Kind   string       `json:"kind,omitempty"`
	Media  *simkl.Media `json:"media,omitempty"`
	List   string       `json:"list,omitempty"`
	Rating int          `json:"rating,omitempty"`
}

// aniListJob is an entry's progress for AniList, or with Op a list or score
// change.
type aniListJob struct {
	Media   int `json:"media"`
	Episode int `json:"episode"`

	Op     string `json:"op,omitempty"`
	Status string `json:"status,omitempty"`
	Score  int    `json:"score,omitempty"`
}

// Backoff: 30 s, doubling to 1 h. A job older than jobMaxAge is dropped.
const (
	retryFirst = 30 * time.Second
	retryMax   = time.Hour
	jobMaxAge  = 30 * 24 * time.Hour
	// idleCheck is how often the queue is looked at with nothing due.
	idleCheck = 10 * time.Minute
)

// queue keeps payload as a job for profile id, and has the scrobbler look
// at the queue.
func (s *Service) queue(profileID uint64, service string, payload any) {
	data, err := json.Marshal(payload)
	if err != nil {
		return
	}
	now := s.now()
	job := store.TrackingJob{Service: service, Payload: data, Created: now.UnixMilli(), NextAt: now.Add(retryFirst).UnixMilli()}
	if _, err := s.open().QueueTrackingJob(profileID, job); err != nil {
		slog.Warn("tracking: job not kept", "service", service, "error", err)
		return
	}
	select {
	case s.scrobbler.kick <- struct{}{}:
	default:
	}
}

// sendJobs sends every profile's due jobs and returns how long until the
// next is due.
func (s *Service) sendJobs(ctx context.Context) time.Duration {
	db := s.open()
	next := idleCheck
	if db == nil {
		return next
	}
	profiles, err := db.TrackedProfiles()
	if err != nil {
		return next
	}
	now := s.now()
	for profileID := range profiles {
		jobs, err := db.TrackingJobs(profileID)
		if err != nil {
			continue
		}
		for _, job := range jobs {
			if due := time.UnixMilli(job.NextAt); due.After(now) {
				next = min(next, due.Sub(now))
				continue
			}
			if ctx.Err() != nil {
				return next
			}
			if wait, keep := s.sendJob(ctx, db, profileID, job); keep {
				next = min(next, wait)
			}
		}
	}
	return max(next, time.Second)
}

// sendJob sends job once. keep is whether it stays queued, to be sent
// after wait.
func (s *Service) sendJob(ctx context.Context, db *store.Store, profileID uint64, job store.TrackingJob) (wait time.Duration, keep bool) {
	call, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	var err error
	var temporary bool
	switch job.Service {
	case ServiceSimkl:
		var p simklJob
		if err = json.Unmarshal(job.Payload, &p); err == nil {
			err = s.sendSimkl(call, profileID, p)
			temporary = simkl.Temporary(err)
		}
	case ServiceAniList:
		var p aniListJob
		if err = json.Unmarshal(job.Payload, &p); err == nil {
			err = s.sendAniList(call, profileID, p)
			temporary = anilist.Temporary(err)
		}
	}
	temporary = temporary || errors.Is(err, context.DeadlineExceeded)
	if err == nil || !temporary || s.now().Sub(time.UnixMilli(job.Created)) > jobMaxAge {
		if err != nil && !errors.Is(err, ErrNotConnected) {
			slog.Warn("tracking: queued update dropped", "service", job.Service, "error", err)
		}
		_ = db.DropTrackingJobs(profileID, job.Service, job.Seq)
		return 0, false
	}
	job.Attempts++
	wait = backoff(job.Attempts)
	var limited *simkl.RateLimited
	if errors.As(err, &limited) && limited.RetryAfter > wait {
		wait = limited.RetryAfter
	}
	job.NextAt = s.now().Add(wait).UnixMilli()
	_ = db.SaveTrackingJob(profileID, job)
	return wait, true
}

func backoff(attempts int) time.Duration {
	wait := retryFirst
	for range attempts {
		wait *= 2
		if wait >= retryMax {
			return retryMax
		}
	}
	return wait
}

// historyOf is SIMKL's history entry for a kept watch.
func historyOf(p simklJob) simkl.History {
	var h simkl.History
	item := simkl.HistoryItem{WatchedAt: p.WatchedAt}
	switch {
	case p.Item.Movie != nil:
		item.Media = *p.Item.Movie
		h.Movies = []simkl.HistoryItem{item}
	case p.Item.Episode != nil && p.Item.Episode.Season != nil:
		item.Media = *p.Item.Show
		item.WatchedAt = ""
		item.TVDBSeasons = true
		item.Seasons = []simkl.HistorySeason{{
			Number:   *p.Item.Episode.Season,
			Episodes: []simkl.HistoryEp{{Number: p.Item.Episode.Number, WatchedAt: p.WatchedAt}},
		}}
		h.Shows = []simkl.HistoryItem{item}
	case p.Item.Anime != nil && p.Item.Episode != nil:
		item.Media = *p.Item.Anime
		item.WatchedAt = ""
		item.Episodes = []simkl.HistoryEp{{Number: p.Item.Episode.Number, WatchedAt: p.WatchedAt}}
		h.Anime = []simkl.HistoryItem{item}
	case p.Item.Anime != nil:
		item.Media = *p.Item.Anime
		h.Anime = []simkl.HistoryItem{item}
	}
	return h
}
