package store

import (
	"errors"
	"slices"
	"testing"
)

// Recent searches are kept per profile, survive a reopen, and an empty list
// forgets them.
func TestRecentSearchesPerProfile(t *testing.T) {
	s, path := openTemp(t)
	anna := must[Profile](t)(s.CreateProfile(Profile{Name: "Anna"}))
	ben := must[Profile](t)(s.CreateProfile(Profile{Name: "Ben"}))

	if got := must[[]string](t)(s.RecentSearches(anna.ID)); got == nil || len(got) != 0 {
		t.Fatalf("before any search: %#v", got)
	}
	check(t, s.SetRecentSearches(anna.ID, []string{"dune", "arrival"}))
	check(t, s.Close())

	s, err := Open(path)
	check(t, err)
	defer s.Close()
	if got := must[[]string](t)(s.RecentSearches(anna.ID)); !slices.Equal(got, []string{"dune", "arrival"}) {
		t.Fatalf("after reopen: %v", got)
	}
	if got := must[[]string](t)(s.RecentSearches(ben.ID)); len(got) != 0 {
		t.Fatalf("another profile: %v", got)
	}

	check(t, s.SetRecentSearches(anna.ID, nil))
	if got := must[[]string](t)(s.RecentSearches(anna.ID)); len(got) != 0 {
		t.Fatalf("forgotten: %v", got)
	}
	if _, err := s.RecentSearches(999); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("unknown profile: %v", err)
	}
}

func TestRecentSearchesValidation(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "Anna"}))
	tooMany := make([]string, MaxRecentSearches+1)
	for i := range tooMany {
		tooMany[i] = string(rune('a' + i))
	}
	for _, list := range [][]string{tooMany, {"ok", "  "}} {
		if err := s.SetRecentSearches(p.ID, list); !errors.Is(err, ErrInvalidItem) {
			t.Fatalf("%q: %v", list, err)
		}
	}
}
