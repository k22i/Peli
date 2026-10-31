package tracking

import (
	"context"
	"errors"
	"log/slog"
	"strconv"
	"time"

	"github.com/k22i/Sinag/internal/anilist"
	"github.com/k22i/Sinag/internal/animelist"
	"github.com/k22i/Sinag/internal/simkl"
	"github.com/k22i/Sinag/internal/store"
)

// Imports (#74, #105): SIMKL's watched history and the AniList list become
// watched marks, which go to Nuvio like any other. Precedence (ADR-0042):
// watched wins. An import only adds marks; a mark is never removed by one,
// on either side, and progress newer than the imported watch is kept
// (store.ImportWatched). Anime marks go to the Kitsu id when the anime list
// has one, which the anime addons use, and to the IMDb id with TVDB's
// numbering otherwise.
//
// SIMKL's import reads /sync/activities first and only asks for what changed
// after the last import's time (date_from), never on a timer: on launch,
// when the window gets focus (at most every autoEvery), on connecting, and
// when Settings asks.

// autoEvery is how often a launch or focus imports at most.
const autoEvery = 15 * time.Minute

// Imported is what an import did.
type Imported struct {
	Simkl   int `json:"simkl"`
	AniList int `json:"anilist"`
}

// Import imports profile id's SIMKL history and AniList list, as far as its
// settings allow, and returns how many marks each added.
func (s *Service) Import(ctx context.Context, profileID uint64) (Imported, error) {
	s.importMu.Lock()
	if s.importing[profileID] {
		s.importMu.Unlock()
		return Imported{}, nil
	}
	s.importing[profileID] = true
	s.lastAuto[profileID] = s.now()
	s.importMu.Unlock()
	defer func() {
		s.importMu.Lock()
		delete(s.importing, profileID)
		s.importMu.Unlock()
	}()

	db := s.open()
	if db == nil {
		return Imported{}, ErrNotConnected
	}
	t, err := db.Tracking(profileID)
	if err != nil {
		return Imported{}, err
	}
	settings := s.settings(db, profileID)
	var done Imported
	var errs []error
	if t.Simkl != nil && !t.Simkl.NeedsReconnect && settings.SimklImport {
		n, err := s.importSimkl(ctx, db, profileID, settings.SimklAnime)
		done.Simkl = n
		errs = append(errs, err)
	}
	if t.AniList != nil && !t.AniList.NeedsReconnect && settings.AniListImport {
		n, err := s.importAniList(ctx, db, profileID)
		done.AniList = n
		errs = append(errs, err)
	}
	if done.Simkl+done.AniList > 0 {
		s.emit(EventImported, profileID)
	}
	err = errors.Join(errs...)
	if errors.Is(err, ErrNotConnected) {
		err = nil
	}
	return done, err
}

// ImportSoon imports for profile id in the background, unless it did
// within autoEvery: on launch, focus and switching profiles.
func (s *Service) ImportSoon(profileID uint64) {
	s.importMu.Lock()
	recent := s.now().Sub(s.lastAuto[profileID]) < autoEvery
	s.importMu.Unlock()
	if recent {
		return
	}
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		if _, err := s.Import(ctx, profileID); err != nil {
			slog.Info("tracking: import failed", "error", err)
		}
	}()
}

// --- SIMKL ----------------------------------------------------------------------

func (s *Service) importSimkl(ctx context.Context, db *store.Store, profileID uint64, anime bool) (int, error) {
	t, err := db.Tracking(profileID)
	if err != nil || t.Simkl == nil {
		return 0, err
	}
	since := t.Simkl.Imported
	var acts simkl.Activities
	err = s.withSimkl(ctx, profileID, func(token string) error {
		acts, err = s.simkl.Activities(ctx, token)
		return err
	})
	if err != nil {
		return 0, wrap("SIMKL activities", err)
	}
	added := 0
	if since == "" || acts.All != since {
		kinds := []struct {
			name  string
			group simkl.ActivityGroup
		}{{"movies", acts.Movies}, {"shows", acts.TVShows}}
		if anime {
			kinds = append(kinds, struct {
				name  string
				group simkl.ActivityGroup
			}{"anime", acts.Anime})
		}
		for _, kind := range kinds {
			// Only the lists that moved; RFC 3339 times in UTC compare as
			// strings.
			if since != "" && kind.group.All <= since {
				continue
			}
			var lib simkl.Library
			err := s.withSimkl(ctx, profileID, func(token string) error {
				lib, err = s.simkl.WatchedLibrary(ctx, token, kind.name, since)
				return err
			})
			if err != nil {
				// Keep the old time, so the next import asks again.
				return added, wrap("SIMKL "+kind.name, err)
			}
			n, err := db.ImportWatched(profileID, s.simklMarks(ctx, lib))
			added += n
			if err != nil {
				return added, err
			}
		}
	}
	err = db.UpdateTracking(profileID, func(t *store.Tracking) error {
		if t.Simkl != nil {
			t.Simkl.Imported, t.Simkl.ImportedAt = acts.All, s.now().UnixMilli()
		}
		return nil
	})
	return added, err
}

// simklMarks are the watched marks lib's films and episodes make.
func (s *Service) simklMarks(ctx context.Context, lib simkl.Library) []store.WatchedItem {
	var marks []store.WatchedItem
	now := s.now().UnixMilli()
	for _, item := range lib.Movies {
		if item.Movie == nil || item.Status != "completed" && item.LastWatchedAt == nil {
			continue
		}
		if imdb := item.Movie.ID("imdb"); imdbID.MatchString(imdb) {
			marks = append(marks, store.WatchedItem{
				ContentID: imdb, ContentType: "movie", Title: item.Movie.Title,
				WatchedAt: millis(item.LastWatchedAt, now),
			})
		}
	}
	for _, item := range lib.Shows {
		if item.Show == nil {
			continue
		}
		imdb := item.Show.ID("imdb")
		if !imdbID.MatchString(imdb) {
			continue
		}
		for _, season := range item.Seasons {
			for _, ep := range season.Episodes {
				marks = append(marks, episodeMark(imdb, item.Show.Title, season.Number, ep.Number, millis(ep.WatchedAt, now)))
			}
		}
	}
	for _, item := range lib.Anime {
		marks = append(marks, s.simklAnimeMarks(ctx, item, now)...)
	}
	return marks
}

// simklAnimeMarks: SIMKL numbers an anime's episodes within its entry, as
// Kitsu does, and with full_anime_seasons says where each falls in TVDB's.
func (s *Service) simklAnimeMarks(ctx context.Context, item simkl.LibraryItem, now int64) []store.WatchedItem {
	if item.Show == nil {
		return nil
	}
	show := item.Show
	kitsu := s.kitsuOf(ctx, show)
	imdb := show.ID("imdb")
	film := item.AnimeType == "movie"
	var marks []store.WatchedItem
	switch {
	case film && (item.Status == "completed" || item.LastWatchedAt != nil):
		at := millis(item.LastWatchedAt, now)
		if kitsu != 0 {
			marks = append(marks, store.WatchedItem{ContentID: "kitsu:" + strconv.Itoa(kitsu), ContentType: "movie", Title: show.Title, WatchedAt: at})
		} else if imdbID.MatchString(imdb) {
			marks = append(marks, store.WatchedItem{ContentID: imdb, ContentType: "movie", Title: show.Title, WatchedAt: at})
		}
	case !film:
		for _, season := range item.Seasons {
			for _, ep := range season.Episodes {
				at := millis(ep.WatchedAt, now)
				switch {
				case kitsu != 0:
					marks = append(marks, episodeMark("kitsu:"+strconv.Itoa(kitsu), show.Title, 1, ep.Number, at))
				case imdbID.MatchString(imdb) && ep.TVDB != nil:
					marks = append(marks, episodeMark(imdb, show.Title, ep.TVDB.Season, ep.TVDB.Episode, at))
				}
			}
		}
	}
	return marks
}

// kitsuOf finds an anime's Kitsu id from the ids SIMKL has for it.
func (s *Service) kitsuOf(ctx context.Context, m *simkl.LibraryMedia) int {
	if kitsu, err := strconv.Atoi(m.ID("kitsu")); err == nil && kitsu > 0 {
		return kitsu
	}
	if s.anime == nil {
		return 0
	}
	if id, err := strconv.Atoi(m.ID("anilist")); err == nil {
		if entry, ok := s.anime.ByAniList(ctx, id); ok {
			return entry.Kitsu
		}
	}
	if mal, err := strconv.Atoi(m.ID("mal")); err == nil {
		if entry, _, ok := s.anime.Find(ctx, animelist.Ref{MAL: mal}); ok {
			return entry.Kitsu
		}
	}
	return 0
}

// --- AniList ------------------------------------------------------------------

func (s *Service) importAniList(ctx context.Context, db *store.Store, profileID uint64) (int, error) {
	var entries []anilist.ListEntry
	var link store.AniListLink
	err := s.withAniList(ctx, profileID, func(l store.AniListLink, token string) error {
		link = l
		var err error
		entries, err = s.anilist.List(ctx, token, l.UserID)
		return err
	})
	if err != nil {
		return 0, wrap("AniList list", err)
	}
	newest := link.Imported
	var marks []store.WatchedItem
	for _, entry := range entries {
		if entry.UpdatedAt <= link.Imported {
			continue
		}
		newest = max(newest, entry.UpdatedAt)
		marks = append(marks, s.aniListMarks(ctx, entry)...)
	}
	added, err := db.ImportWatched(profileID, marks)
	if err != nil {
		return added, err
	}
	err = db.UpdateTracking(profileID, func(t *store.Tracking) error {
		if t.AniList != nil {
			t.AniList.Imported, t.AniList.ImportedAt = newest, s.now().UnixMilli()
		}
		return nil
	})
	return added, err
}

// aniListMarks are the marks an entry makes: its episodes up to its
// progress, or all of them once completed.
func (s *Service) aniListMarks(ctx context.Context, entry anilist.ListEntry) []store.WatchedItem {
	if s.anime == nil {
		return nil
	}
	mapped, ok := s.anime.ByAniList(ctx, entry.Media.ID)
	if !ok {
		return nil
	}
	watched := entry.Progress
	if entry.Status == anilist.StatusCompleted || entry.Status == anilist.StatusRepeating {
		if entry.Media.Episodes != nil {
			watched = max(watched, *entry.Media.Episodes)
		}
	}
	at := entry.UpdatedAt * 1000
	if c := entry.CompletedAt; entry.Status == anilist.StatusCompleted && c.Year != nil && c.Month != nil && c.Day != nil {
		at = time.Date(*c.Year, time.Month(*c.Month), *c.Day, 12, 0, 0, 0, time.UTC).UnixMilli()
	}
	imdb := ""
	if len(mapped.IMDb) > 0 && imdbID.MatchString(mapped.IMDb[0]) {
		imdb = mapped.IMDb[0]
	}
	film := entry.Media.Format == "MOVIE" || mapped.Type == "MOVIE"
	if film {
		if watched < 1 {
			return nil
		}
		switch {
		case mapped.Kitsu != 0:
			return []store.WatchedItem{{ContentID: "kitsu:" + strconv.Itoa(mapped.Kitsu), ContentType: "movie", WatchedAt: at}}
		case imdb != "":
			return []store.WatchedItem{{ContentID: imdb, ContentType: "movie", WatchedAt: at}}
		}
		return nil
	}
	var marks []store.WatchedItem
	for ep := 1; ep <= watched; ep++ {
		switch {
		case mapped.Kitsu != 0:
			marks = append(marks, episodeMark("kitsu:"+strconv.Itoa(mapped.Kitsu), "", 1, ep, at))
		case imdb != "" && mapped.Season != nil:
			marks = append(marks, episodeMark(imdb, "", *mapped.Season, mapped.Offset+ep, at))
		}
	}
	return marks
}

// --- helpers --------------------------------------------------------------------

func episodeMark(contentID, title string, season, episode int, at int64) store.WatchedItem {
	return store.WatchedItem{
		ContentID: contentID, ContentType: "series", Title: title,
		Season: &season, Episode: &episode, WatchedAt: at,
	}
}

// millis reads a SIMKL time, or returns fallback.
func millis(at *string, fallback int64) int64 {
	if at == nil {
		return fallback
	}
	t, err := time.Parse(time.RFC3339, *at)
	if err != nil {
		return fallback
	}
	return t.UnixMilli()
}
