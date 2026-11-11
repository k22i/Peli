package animelist

import (
	"context"
	"slices"
	"strconv"
	"strings"
)

// Service is the Wails service the frontend asks which IMDb ids are anime,
// to leave them out of Movies and Shows (#109, ADR-0045).
type Service struct{ list *List }

// NewService returns a service over list.
func NewService(list *List) *Service { return &Service{list: list} }

// AnimeIDs are the IMDb ids the anime list knows. Ready is false while
// there's no copy of the list (first run, offline): then nothing is anime
// yet, and the frontend asks again later.
type AnimeIDs struct {
	IMDb  []string `json:"imdb"`
	Ready bool     `json:"ready"`
}

// IMDbIDs returns every IMDb id the anime list knows, sorted.
func (s *Service) IMDbIDs(ctx context.Context) AnimeIDs {
	ids, ok := s.list.IMDbIDs(ctx)
	return AnimeIDs{IMDb: ids, Ready: ok}
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

// PosterTitle returns the IMDb title whose poster stands for id ("kitsu:N"
// or "anilist:N", as the Anime tab's items are named), only when the entry
// is that title one to one: a film, or a show's only season. A later
// season, a cour of a split season, or a show AniList splits into several
// entries all share the show's IMDb id, and its poster would stand for none
// of them, so they keep AniList's cover (an empty PosterTitle).
func (s *Service) PosterTitle(ctx context.Context, id string) PosterTitle {
	title, _ := s.list.PosterTitle(ctx, id)
	return title
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
