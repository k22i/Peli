package tracking

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strconv"
	"strings"
	"time"

	"github.com/k22i/Peli/internal/anilist"
	"github.com/k22i/Peli/internal/player"
	"github.com/k22i/Peli/internal/simkl"
	"github.com/k22i/Peli/internal/store"
)

// Actions the user takes on a title: put it on a list, rate it, and read the
// watchlist back. One shape for both services: the UI says "planned" and
// Peli says plantowatch to SIMKL and PLANNING to AniList. A change goes to
// every connected service that can hold the title; one that can't be
// reached is kept in the outbox and sent later, like a watch.

// Peli's statuses. "none" takes the title off the lists.
const (
	StatusPlanned   = "planned"
	StatusWatching  = "watching"
	StatusCompleted = "completed"
	StatusPaused    = "paused"
	StatusDropped   = "dropped"
	StatusNone      = "none"
)

// Job ops, in the outbox.
const (
	opStatus = "status"
	opRemove = "remove"
	opRate   = "rate"
	opUnrate = "unrate"
)

// ErrNotTrackable means no connected service could be given the title: it
// has no ids either knows, or its status isn't one they keep (SIMKL has no
// "watching" film).
var ErrNotTrackable = errors.New("tracking: nothing to track the title with")

// CodeNotTrackable is ErrNotTrackable's code for the frontend.
const CodeNotTrackable = "not_trackable"

// ErrBadStatus means the status isn't one of Peli's, or the rating isn't
// 0–10.
var ErrBadStatus = errors.New("tracking: unknown status or rating")

// listsFetched is how long a profile's SIMKL lists are trusted before
// TitleStatus asks again. A write drops them at once.
const listsFetched = 5 * time.Minute

// TitleRef names a title the way the app does: the addon's content id and
// type, and the ids its meta gave (the same Watching.IDs the player sends).
type TitleRef struct {
	// "movie" or "series".
	Type string `json:"type"`
	// The addon's content id: "tt0903747", "kitsu:46474"…
	ID   string `json:"id"`
	Name string `json:"name"`
	Year int    `json:"year"`
	// Other catalogs' ids by name ("tmdb", "tvdb", "imdb", "mal"…).
	IDs map[string]string `json:"ids"`
}

func (r TitleRef) watching(profileID uint64) player.Watching {
	return player.Watching{ProfileID: profileID, ContentID: r.ID, ContentType: r.Type, Name: r.Name, Year: r.Year, IDs: r.IDs}
}

// TitleTracking is what the connected services say about a title.
type TitleTracking struct {
	// One of Peli's statuses; "none" when it's on no list.
	Status string `json:"status"`
	// The user's rating, 1–10; 0 for none.
	Rating int `json:"rating"`
	// The services that have the title on a list, "simkl" and "anilist".
	Services []string `json:"services"`
	// A change is waiting in the outbox to be sent.
	Queued bool `json:"queued"`
}

// WatchlistItem is a planned title, ready to open like any addon's.
type WatchlistItem struct {
	// The content id to open it with: IMDb's when there is one, as addons
	// use it, else Kitsu's or another catalog's.
	ID   string `json:"id"`
	Type string `json:"type"`
	Name string `json:"name"`
	Year int    `json:"year"`
	// A picture URL, or "".
	Poster   string            `json:"poster"`
	IDs      map[string]string `json:"ids"`
	Services []string          `json:"services"`
}

// guardKids refuses kids profiles: they track nothing.
func (s *Service) guardKids(profileID uint64) error { return s.canConnect(profileID) }

var simklLists = map[string]string{
	StatusPlanned:   simkl.ListPlanToWatch,
	StatusWatching:  simkl.ListWatching,
	StatusCompleted: simkl.ListCompleted,
	StatusPaused:    simkl.ListHold,
	StatusDropped:   simkl.ListDropped,
}

var aniListStatuses = map[string]string{
	StatusPlanned:   anilist.StatusPlanning,
	StatusWatching:  anilist.StatusCurrent,
	StatusCompleted: anilist.StatusCompleted,
	StatusPaused:    anilist.StatusPaused,
	StatusDropped:   anilist.StatusDropped,
}

// simklStatus is Peli's name for one of SIMKL's lists.
func simklStatus(list string) string {
	for status, l := range simklLists {
		if l == list {
			return status
		}
	}
	return StatusNone
}

func aniListStatus(status string) string {
	switch status {
	case anilist.StatusRepeating:
		return StatusWatching
	}
	for peli, l := range aniListStatuses {
		if l == status {
			return peli
		}
	}
	return StatusNone
}

// simklHolds reports whether SIMKL keeps a title of kind on that status.
// Films are planned, completed or dropped; they aren't watched in parts.
func simklHolds(kind, status string) bool {
	if kind == "movies" {
		return status != StatusWatching && status != StatusPaused
	}
	return true
}

// simklTitle is the kind of list SIMKL files ref under ("movies", "shows",
// or "anime" for an anime catalog's own ids) and the title to name it by.
func simklTitle(w player.Watching) (string, *simkl.Media, bool) {
	all := ids(w)
	native := animeNative(w)
	keys := westernKeys
	if native {
		keys = animeKeys
	}
	media := &simkl.Media{Title: w.Name, Year: w.Year, IDs: simkl.IDs{}}
	for _, key := range keys {
		if all[key] != "" {
			media.IDs[key] = all[key]
		}
	}
	if len(media.IDs) == 0 {
		return "", nil, false
	}
	switch {
	case native:
		return "anime", media, true
	case isMovie(w):
		return "movies", media, true
	}
	return "shows", media, true
}

// simklKinds are the lists to look for w on: anime catalogued by IMDb ids
// sit under SIMKL's anime.
func (s *Service) simklKinds(ctx context.Context, w player.Watching, kind string) []string {
	if kind != "shows" || !s.isAnime(ctx, w) {
		return []string{kind}
	}
	return []string{"shows", "anime"}
}

// aniListMedia finds the AniList entry for w, if it's anime.
func (s *Service) aniListMedia(ctx context.Context, w player.Watching) (int, bool) {
	if !s.isAnime(ctx, w) {
		return 0, false
	}
	// A title as a whole is its first season's entry.
	if w.Season == nil && !isMovie(w) && !animeNative(w) {
		one := 1
		w.Season = &one
	}
	if w.Episode == nil {
		one := 1
		w.Episode = &one
	}
	job, ok := s.aniListJob(ctx, w)
	return job.Media, ok
}

// connections returns what profile id is connected to, kids refused.
func (s *Service) connections(profileID uint64) (simklOn, aniOn bool, err error) {
	if err := s.guardKids(profileID); err != nil {
		return false, false, err
	}
	t, err := s.open().Tracking(profileID)
	if err != nil {
		return false, false, err
	}
	return t.Simkl != nil && !t.Simkl.NeedsReconnect, t.AniList != nil && !t.AniList.NeedsReconnect, nil
}

// SetStatus puts the title on the status in every connected service that can
// hold it, and returns what it is now. Changes that can't be sent yet are
// kept and sent later (Queued).
func (s *Service) SetStatus(ctx context.Context, profileID uint64, ref TitleRef, status string) (TitleTracking, error) {
	if _, ok := simklLists[status]; !ok && status != StatusNone {
		return TitleTracking{}, ErrBadStatus
	}
	return s.change(ctx, profileID, ref, func(kind string, media *simkl.Media) (simklJob, bool) {
		if status != StatusNone && !simklHolds(kind, status) {
			return simklJob{}, false
		}
		if status == StatusNone {
			return simklJob{Op: opRemove, Kind: kind, Media: media}, true
		}
		return simklJob{Op: opStatus, Kind: kind, Media: media, List: simklLists[status]}, true
	}, func(id int) aniListJob {
		if status == StatusNone {
			return aniListJob{Op: opRemove, Media: id}
		}
		return aniListJob{Op: opStatus, Media: id, Status: aniListStatuses[status]}
	}, func(t *TitleTracking) {
		t.Status = status
		if status == StatusNone {
			t.Services = nil
		}
	})
}

// SetRating gives the title a rating from 1 to 10 in every connected
// service, or clears it with 0. AniList takes it out of 100 in whatever
// format the user keeps their scores in.
func (s *Service) SetRating(ctx context.Context, profileID uint64, ref TitleRef, rating int) (TitleTracking, error) {
	if rating < 0 || rating > 10 {
		return TitleTracking{}, ErrBadStatus
	}
	return s.change(ctx, profileID, ref, func(kind string, media *simkl.Media) (simklJob, bool) {
		if rating == 0 {
			return simklJob{Op: opUnrate, Kind: kind, Media: media}, true
		}
		return simklJob{Op: opRate, Kind: kind, Media: media, Rating: rating}, true
	}, func(id int) aniListJob {
		return aniListJob{Op: opRate, Media: id, Score: rating * 10}
	}, func(t *TitleTracking) { t.Rating = rating })
}

// change sends one change to both services. simklFor and aniFor build the
// jobs; apply fills in what the answer says about the title.
func (s *Service) change(ctx context.Context, profileID uint64, ref TitleRef,
	simklFor func(kind string, media *simkl.Media) (simklJob, bool), aniFor func(media int) aniListJob, apply func(*TitleTracking)) (TitleTracking, error) {
	simklOn, aniOn, err := s.connections(profileID)
	if err != nil {
		return TitleTracking{}, err
	}
	if !simklOn && !aniOn {
		return TitleTracking{}, ErrNotConnected
	}
	w := ref.watching(profileID)
	var out TitleTracking
	var errs []error
	sent := 0
	attempt := func(service string, err error, queue func()) {
		switch {
		case err == nil:
			sent++
		case simkl.Temporary(err) || anilist.Temporary(err) || errors.Is(err, context.DeadlineExceeded):
			queue()
			out.Queued = true
			sent++
		case errors.Is(err, simkl.ErrNotFound):
			// SIMKL doesn't know the title.
		default:
			slog.Warn("tracking: change failed", "service", service, "error", err)
			errs = append(errs, err)
		}
	}
	if simklOn {
		if kind, media, ok := simklTitle(w); ok {
			if job, ok := simklFor(kind, media); ok {
				call, cancel := context.WithTimeout(ctx, callTimeout)
				attempt(ServiceSimkl, s.sendSimkl(call, profileID, job), func() { s.queue(profileID, ServiceSimkl, job) })
				cancel()
			}
		}
	}
	if aniOn {
		if id, ok := s.aniListMedia(ctx, w); ok {
			job := aniFor(id)
			call, cancel := context.WithTimeout(ctx, callTimeout)
			attempt(ServiceAniList, s.sendAniList(call, profileID, job), func() { s.queue(profileID, ServiceAniList, job) })
			cancel()
		}
	}
	if sent == 0 {
		if len(errs) > 0 {
			return TitleTracking{}, errors.Join(errs...)
		}
		return TitleTracking{}, ErrNotTrackable
	}
	s.forgetLists(profileID)
	s.emit(EventChanged, profileID)
	// What was asked for is what it is now, whatever a list read straight
	// after still says; the rest is what the services hold.
	queued := out.Queued
	out = TitleTracking{Status: StatusNone}
	if got, err := s.TitleStatus(ctx, profileID, ref); err == nil {
		out = got
	}
	apply(&out)
	out.Queued = queued || out.Queued
	return out, nil
}

// sendSimkl sends one SIMKL job: a watch, or a list or rating change.
func (s *Service) sendSimkl(ctx context.Context, profileID uint64, p simklJob) error {
	return s.withSimkl(ctx, profileID, func(token string) error {
		switch p.Op {
		case "":
			return s.simkl.AddHistory(ctx, token, historyOf(p))
		case opStatus:
			item := simkl.ListItem{Media: *p.Media, To: p.List}
			var move simkl.ListMove
			switch p.Kind {
			case "movies":
				move.Movies = []simkl.ListItem{item}
			case "anime":
				move.Anime = []simkl.ListItem{item}
			default:
				move.Shows = []simkl.ListItem{item}
			}
			return s.simkl.AddToList(ctx, token, move)
		case opRemove:
			var h simkl.History
			item := simkl.HistoryItem{Media: simkl.Media{IDs: p.Media.IDs}}
			switch p.Kind {
			case "movies":
				h.Movies = []simkl.HistoryItem{item}
			case "anime":
				h.Anime = []simkl.HistoryItem{item}
			default:
				h.Shows = []simkl.HistoryItem{item}
			}
			return s.simkl.RemoveFromList(ctx, token, h)
		case opRate, opUnrate:
			item := simkl.RatedItem{Media: simkl.Media{IDs: p.Media.IDs}, Rating: p.Rating}
			var r simkl.Ratings
			switch p.Kind {
			case "movies":
				r.Movies = []simkl.RatedItem{item}
			case "anime":
				r.Anime = []simkl.RatedItem{item}
			default:
				r.Shows = []simkl.RatedItem{item}
			}
			if p.Op == opUnrate {
				return s.simkl.Unrate(ctx, token, r)
			}
			return s.simkl.Rate(ctx, token, r)
		}
		return fmt.Errorf("tracking: unknown SIMKL job %q", p.Op)
	})
}

// changeAniList sends one AniList list or score change.
func (s *Service) changeAniList(ctx context.Context, profileID uint64, job aniListJob) error {
	return s.withAniList(ctx, profileID, func(_ store.AniListLink, token string) error {
		switch job.Op {
		case opStatus:
			return s.anilist.SaveStatus(ctx, token, job.Media, job.Status)
		case opRate:
			return s.anilist.SaveScore(ctx, token, job.Media, job.Score)
		case opRemove:
			media, err := s.anilist.WithEntry(ctx, token, job.Media)
			if err != nil || media.Entry == nil {
				return err
			}
			return s.anilist.DeleteEntry(ctx, token, media.Entry.ID)
		}
		return fmt.Errorf("tracking: unknown AniList job %q", job.Op)
	})
}

// --- reading ---------------------------------------------------------------------

// pending reports whether a change for profile id is waiting to be sent.
func (s *Service) pending(profileID uint64) bool {
	jobs, err := s.open().TrackingJobs(profileID)
	if err != nil {
		return false
	}
	for _, job := range jobs {
		if strings.Contains(string(job.Payload), `"op"`) {
			return true
		}
	}
	return false
}

// TitleStatus returns what the connected services say about the title. A
// profile with no connection, or a title they don't know, is "none". It only
// fails when every service asked failed.
func (s *Service) TitleStatus(ctx context.Context, profileID uint64, ref TitleRef) (TitleTracking, error) {
	simklOn, aniOn, err := s.connections(profileID)
	if err != nil {
		return TitleTracking{}, err
	}
	out := TitleTracking{Status: StatusNone, Queued: s.pending(profileID)}
	w := ref.watching(profileID)
	asked := 0
	var errs []error
	if simklOn {
		if kind, media, ok := simklTitle(w); ok {
			asked++
			item, err := s.findSimkl(ctx, profileID, s.simklKinds(ctx, w, kind), media.IDs)
			if err != nil {
				errs = append(errs, err)
			} else if item != nil {
				out.Services = append(out.Services, ServiceSimkl)
				out.Status = simklStatus(item.Status)
				if item.UserRating != nil {
					out.Rating = *item.UserRating
				}
			}
		}
	}
	if aniOn {
		if id, ok := s.aniListMedia(ctx, w); ok {
			asked++
			call, cancel := context.WithTimeout(ctx, callTimeout)
			var media anilist.Media
			err := s.withAniList(call, profileID, func(_ store.AniListLink, token string) (err error) {
				media, err = s.anilist.WithEntry(call, token, id)
				return err
			})
			cancel()
			if err != nil {
				errs = append(errs, err)
			} else if e := media.Entry; e != nil {
				out.Services = append(out.Services, ServiceAniList)
				if out.Status == StatusNone {
					out.Status = aniListStatus(e.Status)
				}
				if out.Rating == 0 {
					out.Rating = (e.Score + 5) / 10
				}
			}
		}
	}
	if asked > 0 && len(errs) == asked {
		return TitleTracking{}, errors.Join(errs...)
	}
	return out, nil
}

// findSimkl looks for a title with one of the ids on profile id's SIMKL
// lists of the kinds given.
func (s *Service) findSimkl(ctx context.Context, profileID uint64, kinds []string, want simkl.IDs) (*simkl.LibraryItem, error) {
	for _, k := range kinds {
		items, err := s.simklLists(ctx, profileID, k)
		if err != nil {
			return nil, err
		}
		for i := range items {
			if m := mediaOf(items[i]); m != nil && sharesID(want, *m) {
				return &items[i], nil
			}
		}
	}
	return nil, nil
}

func mediaOf(item simkl.LibraryItem) *simkl.LibraryMedia {
	if item.Movie != nil {
		return item.Movie
	}
	return item.Show
}

var simklIDKeys = []string{"imdb", "tmdb", "tvdb", "mal", "anidb", "anilist", "kitsu"}

// sharesID reports whether the media has one of the ids want has.
func sharesID(want simkl.IDs, m simkl.LibraryMedia) bool {
	for _, key := range simklIDKeys {
		if want[key] != "" && want[key] == m.ID(key) {
			return true
		}
	}
	return false
}

type cachedLists struct {
	at    time.Time
	items []simkl.LibraryItem
}

// simklLists returns profile id's SIMKL titles of kind on every list,
// from a short-lived copy when there is one.
func (s *Service) simklLists(ctx context.Context, profileID uint64, kind string) ([]simkl.LibraryItem, error) {
	key := listKey{profileID, kind}
	s.listsMu.Lock()
	c, ok := s.lists[key]
	s.listsMu.Unlock()
	if ok && s.now().Sub(c.at) < listsFetched {
		return c.items, nil
	}
	call, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	var lib simkl.Library
	err := s.withSimkl(call, profileID, func(token string) (err error) {
		lib, err = s.simkl.Items(call, token, kind, "")
		return err
	})
	if err != nil {
		return nil, err
	}
	items := lib.Movies
	if kind == "shows" {
		items = lib.Shows
	} else if kind == "anime" {
		items = lib.Anime
	}
	s.listsMu.Lock()
	s.lists[key] = cachedLists{at: s.now(), items: items}
	s.listsMu.Unlock()
	return items, nil
}

type listKey struct {
	profile uint64
	kind    string
}

// forgetLists drops profile id's copies of SIMKL's lists.
func (s *Service) forgetLists(profileID uint64) {
	s.listsMu.Lock()
	defer s.listsMu.Unlock()
	for key := range s.lists {
		if key.profile == profileID {
			delete(s.lists, key)
		}
	}
}

// Watchlist returns the planned titles of every connected service, SIMKL's
// first, each once. It only fails when every service asked failed.
func (s *Service) Watchlist(ctx context.Context, profileID uint64) ([]WatchlistItem, error) {
	simklOn, aniOn, err := s.connections(profileID)
	if err != nil {
		return nil, err
	}
	out := []WatchlistItem{}
	asked := 0
	var errs []error
	if simklOn {
		asked++
		items, err := s.simklPlanned(ctx, profileID)
		out = append(out, items...)
		if err != nil {
			errs = append(errs, err)
		}
	}
	if aniOn {
		asked++
		items, err := s.aniListPlanned(ctx, profileID)
		if err != nil {
			errs = append(errs, err)
		}
		for _, item := range items {
			out = mergeWatchlist(out, item)
		}
	}
	if asked > 0 && len(errs) == asked {
		return nil, errors.Join(errs...)
	}
	return out, nil
}

// mergeWatchlist adds item, or notes the service on the entry that has one
// of its ids already.
func mergeWatchlist(list []WatchlistItem, item WatchlistItem) []WatchlistItem {
	for i := range list {
		for key, value := range item.IDs {
			if list[i].IDs[key] == value {
				list[i].Services = append(list[i].Services, item.Services...)
				for k, v := range item.IDs {
					if list[i].IDs[k] == "" {
						list[i].IDs[k] = v
					}
				}
				if list[i].Poster == "" {
					list[i].Poster = item.Poster
				}
				return list
			}
		}
	}
	return append(list, item)
}

// contentID is the id a title opens with: IMDb's, then Kitsu's, then another
// catalog's that Peli's ids() reads back.
func contentID(all map[string]string) string {
	switch {
	case all["imdb"] != "":
		return all["imdb"]
	case all["kitsu"] != "":
		return "kitsu:" + all["kitsu"]
	}
	for _, key := range []string{"tmdb", "mal", "anilist", "anidb", "tvdb"} {
		if all[key] != "" {
			return key + ":" + all[key]
		}
	}
	return ""
}

func (s *Service) simklPlanned(ctx context.Context, profileID uint64) ([]WatchlistItem, error) {
	var out []WatchlistItem
	var errs []error
	for _, kind := range []string{"movies", "shows", "anime"} {
		call, cancel := context.WithTimeout(ctx, callTimeout)
		var lib simkl.Library
		err := s.withSimkl(call, profileID, func(token string) (err error) {
			lib, err = s.simkl.Items(call, token, kind, simkl.ListPlanToWatch)
			return err
		})
		cancel()
		if err != nil {
			errs = append(errs, err)
			continue
		}
		items := map[string][]simkl.LibraryItem{"movies": lib.Movies, "shows": lib.Shows, "anime": lib.Anime}[kind]
		for _, it := range items {
			m := mediaOf(it)
			if m == nil {
				continue
			}
			all := map[string]string{}
			for _, key := range simklIDKeys {
				if v := m.ID(key); v != "" {
					all[key] = v
				}
			}
			id := contentID(all)
			if id == "" {
				continue
			}
			typ := "series"
			if kind == "movies" || it.AnimeType == "movie" {
				typ = "movie"
			}
			out = mergeWatchlist(out, WatchlistItem{ID: id, Type: typ, Name: m.Title, Year: m.Year,
				Poster: simkl.PosterURL(m.Poster), IDs: all, Services: []string{ServiceSimkl}})
		}
	}
	if len(errs) == 3 {
		return nil, errors.Join(errs...)
	}
	return out, nil
}

func (s *Service) aniListPlanned(ctx context.Context, profileID uint64) ([]WatchlistItem, error) {
	var entries []anilist.ListEntry
	call, cancel := context.WithTimeout(ctx, callTimeout)
	defer cancel()
	err := s.withAniList(call, profileID, func(l store.AniListLink, token string) (err error) {
		entries, err = s.anilist.ListByStatus(call, token, l.UserID, anilist.StatusPlanning)
		return err
	})
	if err != nil {
		return nil, err
	}
	var out []WatchlistItem
	for _, e := range entries {
		m := e.Media
		all := map[string]string{"anilist": strconv.Itoa(m.ID)}
		if m.IDMal != nil {
			all["mal"] = strconv.Itoa(*m.IDMal)
		}
		if s.anime != nil {
			if mapped, ok := s.anime.ByAniList(ctx, m.ID); ok {
				if mapped.Kitsu != 0 {
					all["kitsu"] = strconv.Itoa(mapped.Kitsu)
				}
				if len(mapped.IMDb) > 0 {
					all["imdb"] = mapped.IMDb[0]
				}
			}
		}
		item := WatchlistItem{ID: contentID(all), Type: "series", IDs: all, Services: []string{ServiceAniList}}
		if m.Format == "MOVIE" {
			item.Type = "movie"
		}
		if m.Title != nil {
			item.Name = m.Title.English
			if item.Name == "" {
				item.Name = m.Title.Romaji
			}
		}
		if m.CoverImage != nil {
			item.Poster = m.CoverImage.Large
		}
		if m.StartDate != nil && m.StartDate.Year != nil {
			item.Year = *m.StartDate.Year
		}
		out = append(out, item)
	}
	return out, nil
}
