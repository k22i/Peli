package animelist

import (
	"context"
	"slices"
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
