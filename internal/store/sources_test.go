package store

import (
	"errors"
	"testing"
)

// A show's chosen source (#58) is kept per profile and show, replaced by the
// next choice, forgotten on nil, and goes with its profile.
func TestChosenSourcePerProfileAndShow(t *testing.T) {
	s, path := openTemp(t)
	anna := must[Profile](t)(s.CreateProfile(Profile{Name: "Anna"}))
	ben := must[Profile](t)(s.CreateProfile(Profile{Name: "Ben"}))

	if got := must[*ChosenSource](t)(s.ChosenSource(anna.ID, "tt0903747")); got != nil {
		t.Fatalf("before any choice: %+v", got)
	}
	ntb := ChosenSource{Source: "https://torrentio.example/manifest.json", Resolution: "1080p", Group: "NTb", ChosenAt: 1}
	check(t, s.SetChosenSource(anna.ID, "tt0903747", &ntb))
	check(t, s.Close())

	s, err := Open(path)
	check(t, err)
	defer s.Close()
	equal(t, *must[*ChosenSource](t)(s.ChosenSource(anna.ID, "tt0903747")), ntb)
	if got := must[*ChosenSource](t)(s.ChosenSource(ben.ID, "tt0903747")); got != nil {
		t.Fatalf("another profile: %+v", got)
	}
	if got := must[*ChosenSource](t)(s.ChosenSource(anna.ID, "tt1190634")); got != nil {
		t.Fatalf("another show: %+v", got)
	}

	plugin := ChosenSource{Source: "plugin:example", Resolution: "2160p", ChosenAt: 2}
	check(t, s.SetChosenSource(anna.ID, "tt0903747", &plugin))
	equal(t, *must[*ChosenSource](t)(s.ChosenSource(anna.ID, "tt0903747")), plugin)

	check(t, s.SetChosenSource(anna.ID, "tt0903747", nil))
	if got := must[*ChosenSource](t)(s.ChosenSource(anna.ID, "tt0903747")); got != nil {
		t.Fatalf("forgotten: %+v", got)
	}
	// Forgetting with nothing kept is fine.
	check(t, s.SetChosenSource(ben.ID, "tt0903747", nil))

	check(t, s.SetChosenSource(anna.ID, "tt0903747", &ntb))
	check(t, s.DeleteProfile(anna.ID))
	if _, err := s.ChosenSource(anna.ID, "tt0903747"); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("deleted profile's source err = %v", err)
	}
}

func TestChosenSourceValidation(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	if err := s.SetChosenSource(p.ID, "", &ChosenSource{Source: "x"}); !errors.Is(err, ErrInvalidItem) {
		t.Errorf("no content id: err = %v", err)
	}
	if err := s.SetChosenSource(p.ID, "tt1", &ChosenSource{}); !errors.Is(err, ErrInvalidItem) {
		t.Errorf("no source: err = %v", err)
	}
}
