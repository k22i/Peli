package store

import (
	"errors"
	"slices"
	"testing"
)

// Live TV sources are device records naming their profile, listed oldest
// first; favourites and recent channels are per profile.
func TestLiveSources(t *testing.T) {
	s, path := openTemp(t)
	anna := must[Profile](t)(s.CreateProfile(Profile{Name: "Anna"}))
	ben := must[Profile](t)(s.CreateProfile(Profile{Name: "Ben"}))

	check(t, s.PutLiveSource(LiveSource{ID: "b", ProfileID: anna.ID, Name: "Pluto", CreatedAt: 2}))
	check(t, s.PutLiveSource(LiveSource{ID: "a", ProfileID: anna.ID, Name: "iptv-org", CreatedAt: 1}))
	check(t, s.PutLiveSource(LiveSource{ID: "c", ProfileID: ben.ID, Name: "Ben's", CreatedAt: 3}))
	check(t, s.Close())

	s, err := Open(path)
	check(t, err)
	defer s.Close()
	got := must[[]LiveSource](t)(s.LiveSources(anna.ID))
	if len(got) != 2 || got[0].ID != "a" || got[1].ID != "b" {
		t.Fatalf("anna's sources: %+v", got)
	}
	if all := must[[]LiveSource](t)(s.AllLiveSources()); len(all) != 3 {
		t.Fatalf("all: %+v", all)
	}
	if one := must[LiveSource](t)(s.LiveSource("c")); one.Name != "Ben's" {
		t.Fatalf("one: %+v", one)
	}
	check(t, s.DeleteLiveSource("c"))
	check(t, s.DeleteLiveSource("c"))
	if _, err := s.LiveSource("c"); !errors.Is(err, ErrLiveSourceNotFound) {
		t.Fatalf("deleted: %v", err)
	}
	for _, bad := range []LiveSource{
		{ProfileID: anna.ID, Name: "x"},
		{ID: "x", Name: "x"},
		{ID: "x", ProfileID: anna.ID, Name: " "},
	} {
		if err := s.PutLiveSource(bad); !errors.Is(err, ErrInvalidItem) {
			t.Fatalf("%+v: %v", bad, err)
		}
	}
	if err := s.PutLiveSource(LiveSource{ID: "x", ProfileID: 999, Name: "x"}); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("unknown profile: %v", err)
	}

	check(t, s.SetLiveFavourites(anna.ID, []string{"a:1", "a:2"}))
	check(t, s.SetLiveRecent(anna.ID, []string{"a:2"}))
	if fav := must[[]string](t)(s.LiveFavourites(anna.ID)); !slices.Equal(fav, []string{"a:1", "a:2"}) {
		t.Fatalf("favourites: %v", fav)
	}
	if recent := must[[]string](t)(s.LiveRecent(anna.ID)); !slices.Equal(recent, []string{"a:2"}) {
		t.Fatalf("recent: %v", recent)
	}
	if fav := must[[]string](t)(s.LiveFavourites(ben.ID)); fav == nil || len(fav) != 0 {
		t.Fatalf("ben's favourites: %#v", fav)
	}
	if err := s.SetLiveRecent(anna.ID, make([]string, MaxLiveRecent+1)); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("too many: %v", err)
	}
	check(t, s.SetLiveFavourites(anna.ID, nil))
	if fav := must[[]string](t)(s.LiveFavourites(anna.ID)); len(fav) != 0 {
		t.Fatalf("cleared: %v", fav)
	}
}
