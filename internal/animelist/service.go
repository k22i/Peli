package animelist

import (
	"context"
	"runtime"
	"slices"
	"strconv"
	"strings"
)

// Service is the Wails service the frontend asks which IMDb ids are anime,
// to leave them out of Movies and Shows (#109, ADR-0045).
type Service struct{ list *List }

// NewService returns a service over list.
func NewService(list *List) *Service { return &Service{list: list} }

// ready is whether the list is there for a lookup that can do without it.
// The desktop waits for the list, as IMDbIDs did; a phone doesn't (#128):
// its first download may be on mobile data, and a page must not wait on it.
func (l *List) ready(ctx context.Context) bool {
	if runtime.GOOS != "ios" {
		return l.ensure(ctx) == nil
	}
	return l.Peek()
}

// LeaveOutAnswer says, for each id asked, whether it is anime the list
// knows. Ready is false while there's no copy of the list (first run,
// offline, on mobile data before the first Wi-Fi): then nothing is anime
// yet, and the frontend asks again later.
type LeaveOutAnswer struct {
	Anime []bool `json:"anime"`
	Ready bool   `json:"ready"`
}

// LeaveOut says which of ids (catalog item ids: "tt0388629", or an
// episode's "tt0388629:1:1"; anything else is never anime) the anime list
// knows as anime, one page of results at a time (#128): the full id list
// never crosses into the webview. It never waits on the list's download.
func (s *Service) LeaveOut(ctx context.Context, ids []string) LeaveOutAnswer {
	answer := LeaveOutAnswer{Anime: make([]bool, len(ids))}
	if !s.list.ready(ctx) {
		return answer
	}
	answer.Ready = true
	s.list.mu.Lock()
	defer s.list.mu.Unlock()
	for i, id := range ids {
		if !strings.HasPrefix(id, "tt") {
			continue
		}
		imdb, _, _ := strings.Cut(id, ":")
		answer.Anime[i] = len(s.list.imdb[imdb]) > 0
	}
	return answer
}

// IMDbIDs returns every IMDb id the list knows, sorted, and whether the
// list is loaded.
func (l *List) IMDbIDs(ctx context.Context) ([]string, bool) {
	if l.ensure(ctx) != nil {
		return []string{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	ids := make([]string, 0, len(l.imdb))
	for id := range l.imdb {
		ids = append(ids, id)
	}
	slices.Sort(ids)
	return ids, true
}

// Title is the film or show an anime entry belongs to on IMDb, as the
// poster addon (Xperience, BetterPosters…) and search have it: "movie" or
// "series", and for a show the TVDB season the entry starts in (0 when the
// list doesn't say). An empty IMDb id means the entry stays AniList's card.
type Title struct {
	IMDb   string `json:"imdb"`
	Type   string `json:"type"`
	Season int    `json:"season"`
}

// Titles returns the IMDb title each id ("kitsu:N", "anilist:N" or "mal:N",
// as the Anime tab's items are named) belongs to, for one page of results
// at a time (#128). With a poster addon chosen, the Anime tab shows that
// title in place of AniList's entry: one card per show, as the addon has it,
// however many seasons and cours AniList splits it in (ADR-0062). Ready is
// false while the list isn't loaded: then every card stays AniList's and the
// frontend asks again later. On iOS it never waits on the list's download
// (see ready).
func (s *Service) Titles(ctx context.Context, ids []string) Titles {
	answer := Titles{Titles: make([]Title, len(ids))}
	if !s.list.ready(ctx) {
		return answer
	}
	answer.Ready = true
	for i, id := range ids {
		answer.Titles[i], _ = s.list.Title(ctx, id)
	}
	return answer
}

// Titles is the answer to Service.Titles, one title per id.
type Titles struct {
	Titles []Title `json:"titles"`
	Ready  bool    `json:"ready"`
}

// kindOf is what e's IMDb id names: the TMDB id's kind where the list has
// one, else a film for a MOVIE entry and a show for the rest.
func kindOf(e *Entry) string {
	switch {
	case e.TMDB == "movie":
		return "movie"
	case e.TMDB == "tv":
		return "series"
	case e.Type == "MOVIE":
		return "movie"
	}
	return "series"
}

// Title is Service.Title for one id. An entry belongs to its IMDb title when
// it has exactly one IMDb id and is
//   - a show's season or cour (any season but 0): Black Clover's two seasons
//     are both tt7441658, at seasons 1 and 2; or
//   - a film with an IMDb id of its own: Mugen Train is tt11032374, not
//     Demon Slayer's tt9335498.
//
// A special, OVA or film TVDB files as a show's season 0 carries the show's
// IMDb id, but isn't the show (Naruto Shippuden's films), so it stays
// AniList's; so does a film whose IMDb id a show's season also has.
func (l *List) Title(ctx context.Context, id string) (Title, bool) {
	kind, number, found := strings.Cut(id, ":")
	n, err := strconv.Atoi(number)
	if !found || err != nil || l.ensure(ctx) != nil {
		return Title{}, false
	}
	l.mu.Lock()
	defer l.mu.Unlock()
	var e *Entry
	switch kind {
	case "anilist":
		e = l.anilist[n]
	case "kitsu":
		e = l.kitsu[n]
	case "mal":
		e = l.mal[n]
	}
	if e == nil || len(e.IMDb) != 1 {
		return Title{}, false
	}
	imdb := e.IMDb[0]
	if kindOf(e) == "series" {
		season := 0
		if e.Season != nil {
			season = *e.Season
			if season == 0 {
				return Title{}, false
			}
		}
		return Title{IMDb: imdb, Type: "series", Season: season}, true
	}
	for _, other := range l.imdb[imdb] {
		if other != e && kindOf(other) == "series" && (other.Season == nil || *other.Season != 0) {
			return Title{}, false
		}
	}
	return Title{IMDb: imdb, Type: "movie"}, true
}
