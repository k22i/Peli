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

// PosterTitle is the film or show an anime entry is, by IMDb id, for asking
// a poster addon for its art: "movie" or "series". An empty IMDb id means
// the entry keeps AniList's cover.
type PosterTitle struct {
	IMDb string `json:"imdb"`
	Type string `json:"type"`
}

// PosterTitles returns the IMDb title whose poster stands for each id
// ("kitsu:N" or "anilist:N", as the Anime tab's items are named), for one
// page of results at a time (#128), only when the entry is that title one
// to one: a film, or a show's only season. A later season, a cour of a split
// season, or a show AniList splits into several entries all share the
// show's IMDb id, and its poster would stand for none of them, so they keep
// AniList's cover (an empty PosterTitle). Ready is false while the list
// isn't loaded: then every card keeps AniList's cover and the frontend asks
// again later. On iOS it never waits on the list's download (see ready).
func (s *Service) PosterTitles(ctx context.Context, ids []string) PosterTitles {
	answer := PosterTitles{Titles: make([]PosterTitle, len(ids))}
	if !s.list.ready(ctx) {
		return answer
	}
	answer.Ready = true
	for i, id := range ids {
		answer.Titles[i], _ = s.list.PosterTitle(ctx, id)
	}
	return answer
}

// PosterTitles is the answer to Service.PosterTitles, one title per id.
type PosterTitles struct {
	Titles []PosterTitle `json:"titles"`
	Ready  bool          `json:"ready"`
}

// mainTypes are the entry types that count as the title itself; specials
// and OVAs share a show's IMDb id without making it ambiguous.
var mainTypes = []string{"TV", "TV_SHORT", "ONA", "MOVIE"}

// PosterTitle is Service.PosterTitle.
func (l *List) PosterTitle(ctx context.Context, id string) (PosterTitle, bool) {
	kind, number, found := strings.Cut(id, ":")
	n, err := strconv.Atoi(number)
	if !found || err != nil || l.ensure(ctx) != nil {
		return PosterTitle{}, false
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
	if e == nil || len(e.IMDb) != 1 || !slices.Contains(mainTypes, e.Type) {
		return PosterTitle{}, false
	}
	if e.Offset != 0 || (e.Season != nil && *e.Season > 1) {
		return PosterTitle{}, false
	}
	imdb := e.IMDb[0]
	for _, other := range l.imdb[imdb] {
		if other != e && slices.Contains(mainTypes, other.Type) {
			return PosterTitle{}, false
		}
	}
	kindOf := "series"
	if e.Type == "MOVIE" {
		kindOf = "movie"
	}
	return PosterTitle{IMDb: imdb, Type: kindOf}, true
}
