package livetv

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"time"

	"github.com/k22i/Peli/internal/safego"
	"github.com/k22i/Peli/internal/secrets"
	"github.com/k22i/Peli/internal/store"
)

// A source keeps 38 h of guide data: two hours back, so what is on now is
// known, and 36 h ahead, which fills a day and a half of guide without reading
// a week of it into memory.
const (
	guideFrom = 2 * time.Hour
	guideTo   = 36 * time.Hour
)

// startRefresh marks id as refreshing and runs refresh in the background,
// unless one is already running or the service is closing. Marking before the
// goroutine starts is what keeps two of a source's refreshes from overlapping.
func (s *Service) startRefresh(id string, force bool) {
	s.mu.Lock()
	if s.closed || s.refreshing[id] {
		s.mu.Unlock()
		return
	}
	s.refreshing[id] = true
	s.wg.Add(1)
	s.mu.Unlock()
	safego.Go("livetv-refresh", func() {
		defer s.wg.Done()
		s.refresh(id, force)
	})
}

// refresh fetches a source's playlist and guide and caches what it finds,
// keeping the last good copy of either that fails. It runs in its own
// goroutine and emits EventUpdated at each end.
func (s *Service) refresh(id string, force bool) {
	db, err := s.store()
	if err != nil {
		s.clearRefreshing(id)
		return
	}
	rec, err := db.LiveSource(id)
	if err != nil {
		// Removed between the call and this: nothing to fetch.
		s.clearRefreshing(id)
		return
	}
	now := s.now()
	defer func() {
		s.clearRefreshing(id)
		s.emit(EventUpdated, Updated{ProfileID: rec.ProfileID, SourceID: id})
	}()
	s.mu.Lock()
	s.ensureLocked(id).status.LastTry = now.UnixMilli()
	s.mu.Unlock()
	s.emit(EventUpdated, Updated{ProfileID: rec.ProfileID, SourceID: id})

	// The playlist, when it is due. What it parsed is kept for the cache and
	// for the guide's fallback URLs.
	var playlistFresh bool
	var playlist playlistFile
	s.mu.Lock()
	st := s.ensureLocked(id).status
	s.mu.Unlock()
	if force || st.PlaylistAt == 0 || now.Sub(time.UnixMilli(st.PlaylistAt)) >= s.playlistTTL {
		parsed, code := s.readPlaylist(id)
		s.mu.Lock()
		l := s.ensureLocked(id)
		if code != "" {
			l.status.PlaylistError = code
		} else {
			l.put(parsed)
			l.status.PlaylistAt = now.UnixMilli()
			l.status.PlaylistError = ""
			l.status.Channels = len(parsed.Channels)
		}
		s.mu.Unlock()
		if code != "" {
			slog.Warn("livetv: refresh", "source", id, "part", "playlist", "code", code)
		} else {
			playlist, playlistFresh = parsed, true
		}
	}

	// The guide, when it is due and there is a channel to show it for.
	var channels []Channel
	s.mu.Lock()
	l := s.ensureLocked(id)
	guideDue := force || l.status.GuideAt == 0 || playlistFresh ||
		now.Sub(time.UnixMilli(l.status.GuideAt)) >= s.guideTTL
	channels = append([]Channel(nil), l.channels...)
	s.mu.Unlock()

	guideFresh := false
	if guideDue && len(channels) > 0 {
		fallback := playlist.GuideURLs
		if !playlistFresh {
			fallback = s.cachedGuideURLs(id)
		}
		guideFresh = s.refreshGuide(id, channels, fallback, now)
	}

	s.writeCache(db, id, playlist, playlistFresh, guideFresh)
}

// readPlaylist fetches and parses id's playlist. The code is "" when it
// worked; the body is never returned, since it holds a URL.
func (s *Service) readPlaylist(id string) (playlistFile, string) {
	raw, err := s.stored(playlistKey(id))
	if err != nil {
		return playlistFile{}, fetchCode(err)
	}
	ctx, cancel := context.WithTimeout(s.ctx, playlistTimeout)
	defer cancel()
	body, err := s.open(ctx, raw, playlistLimit)
	if err != nil {
		return playlistFile{}, fetchCode(err)
	}
	defer body.Close()
	playlist, err := ParsePlaylist(body)
	if err != nil {
		return playlistFile{}, fetchCode(err)
	}
	return playlistFile{
		GuideURLs: playlist.GuideURLs,
		Entries:   playlist.Entries,
		Channels:  ChannelsOf(id, playlist),
	}, ""
}

// refreshGuide fetches the guide from the first URL that works and replaces
// what was kept. It says whether the guide file changed.
func (s *Service) refreshGuide(id string, channels []Channel, fallback []string, now time.Time) bool {
	urls, fromPlaylist, err := s.guideURLs(id, fallback)
	if err != nil {
		code := fetchCode(err)
		s.guideFailed(id, code)
		slog.Warn("livetv: refresh", "source", id, "part", "guide", "code", code)
		return false
	}
	if len(urls) == 0 {
		// No guide at all: nothing to show, and nothing to wait for.
		return s.guideGone(id)
	}
	code := ""
	for _, raw := range urls {
		guide, err := s.readGuide(raw, channels, now)
		if err == nil {
			s.guideLoaded(id, guide, fromPlaylist, now)
			return true
		}
		code = fetchCode(err)
	}
	// Every URL failed: the last good guide stays, and the source says why.
	s.guideFailed(id, code)
	slog.Warn("livetv: refresh", "source", id, "part", "guide", "code", code)
	return false
}

// guideURLs is where a source's guide comes from: its own URL, or the
// playlist's. fromPlaylist says which, for the frontend to explain.
func (s *Service) guideURLs(id string, fallback []string) ([]string, bool, error) {
	if k := s.cfg.Keychain; k != nil {
		raw, err := k.Get(guideKey(id))
		switch {
		case err == nil && raw != "":
			return []string{raw}, false, nil
		case err != nil && !errors.Is(err, secrets.ErrNotFound):
			return nil, false, err
		}
	}
	return fallback, len(fallback) > 0, nil
}

// readGuide fetches one guide URL and parses it, holding it to the fetch cap
// and then to the larger cap of what it unzips to.
func (s *Service) readGuide(raw string, channels []Channel, now time.Time) (Guide, error) {
	ctx, cancel := context.WithTimeout(s.ctx, guideTimeout)
	defer cancel()
	body, err := s.open(ctx, raw, guideLimit)
	if err != nil {
		return Guide{}, err
	}
	defer body.Close()
	unzipped, err := GuideReader(body)
	if err != nil {
		return Guide{}, err
	}
	capped := &limitBody{
		reader: &limitReader{r: unzipped, left: guideUnzippedLimit},
		closer: io.NopCloser(unzipped),
	}
	guide, err := ParseGuide(capped, NewMatcher(channels), now.Add(-guideFrom), now.Add(guideTo))
	if err != nil {
		// Any failure inside ParseGuide is the guide's fault, not the
		// network's. Its text is dropped: only the code is ever shown.
		return Guide{}, ErrNotGuide
	}
	return guide, nil
}

// guideLoaded keeps what a guide parse found for the channels we have.
func (s *Service) guideLoaded(id string, guide Guide, fromPlaylist bool, now time.Time) {
	total := 0
	for _, programmes := range guide.Programmes {
		total += len(programmes)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	l := s.ensureLocked(id)
	l.guide = guide.Programmes
	if l.guide == nil {
		l.guide = map[string][]Programme{}
	}
	l.status.GuideAt = now.UnixMilli()
	l.status.GuideError = ""
	l.status.Programmes = total
	l.status.GuideChannels = guide.Matched
	l.status.HasGuide = true
	l.status.GuideFromPlaylist = fromPlaylist
}

// guideFailed keeps the guide that was there and says why this try failed.
func (s *Service) guideFailed(id, code string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.ensureLocked(id).status.GuideError = code
}

// guideGone empties a source's guide: it names none, so there is nothing to
// show and nothing to wait for. It says whether the guide file changed.
func (s *Service) guideGone(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	l := s.ensureLocked(id)
	changed := l.status.HasGuide || len(l.guide) > 0 || l.status.GuideAt != 0
	l.guide = map[string][]Programme{}
	l.status.GuideAt = 0
	l.status.GuideError = ""
	l.status.Programmes = 0
	l.status.GuideChannels = 0
	l.status.HasGuide = false
	l.status.GuideFromPlaylist = false
	return changed
}

// writeCache saves what this refresh changed. A source can be removed while
// its refresh runs: nothing is written for one that is gone.
func (s *Service) writeCache(db *store.Store, id string, playlist playlistFile, playlistFresh, guideFresh bool) {
	if _, err := db.LiveSource(id); err != nil {
		return
	}
	s.mu.Lock()
	l := s.ensureLocked(id)
	st := l.status
	var guide guideFile
	if guideFresh {
		guide = guideFile{Programmes: l.guide}
	}
	s.mu.Unlock()
	if playlistFresh {
		if err := s.save(id, filePlaylist, playlist); err != nil {
			slog.Warn("livetv: cache", "source", id, "part", "playlist", "code", CodeFailed)
		}
	}
	if guideFresh {
		if err := s.save(id, fileGuide, guide); err != nil {
			slog.Warn("livetv: cache", "source", id, "part", "guide", "code", CodeFailed)
		}
	}
	if err := s.save(id, fileStatus, st); err != nil {
		slog.Warn("livetv: cache", "source", id, "part", "status", "code", CodeFailed)
	}
}

// clearRefreshing lets the next refresh of id start.
func (s *Service) clearRefreshing(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	delete(s.refreshing, id)
}

// staleness says whether a status is due a refresh: it hasn't been tried
// recently, and either its playlist has aged out or it has a guide that has.
func (s *Service) staleness(st status) bool {
	now := s.now()
	if now.Sub(time.UnixMilli(st.LastTry)) < s.retryAfter {
		return false
	}
	if st.PlaylistAt == 0 || now.Sub(time.UnixMilli(st.PlaylistAt)) >= s.playlistTTL {
		return true
	}
	return st.HasGuide && (st.GuideAt == 0 || now.Sub(time.UnixMilli(st.GuideAt)) >= s.guideTTL)
}

// due says whether id needs a refresh and has none running.
func (s *Service) due(id string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.refreshing[id] {
		return false
	}
	return s.staleness(s.ensureLocked(id).status)
}

// tick refreshes the stale sources of the profile in use. A kids profile has
// no Live TV, so there is nothing there to refresh.
func (s *Service) tick() {
	db, err := s.store()
	if err != nil {
		return
	}
	profile, ok, err := db.ProfileInUse()
	if err != nil || !ok || profile.Kids {
		return
	}
	records, err := db.LiveSources(profile.ID)
	if err != nil {
		return
	}
	for _, rec := range records {
		if s.due(rec.ID) {
			s.startRefresh(rec.ID, false)
		}
	}
}

// sweep forgets the sources of profiles that are gone, with their keychain
// items and cache folders: a deleted profile leaves nothing behind.
func (s *Service) sweep() {
	db, err := s.store()
	if err != nil {
		return
	}
	records, err := db.AllLiveSources()
	if err != nil {
		return
	}
	for _, rec := range records {
		if _, err := db.Profile(rec.ProfileID); !errors.Is(err, store.ErrProfileNotFound) {
			continue
		}
		if err := s.forget(db, rec); err != nil {
			slog.Warn("livetv: sweep", "source", rec.ID, "code", codeOf(err))
		}
	}
}
