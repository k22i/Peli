package livetv

import (
	"reflect"
	"testing"
)

func TestNormaliseName(t *testing.T) {
	cases := map[string]string{
		"BBC One HD":       "bbcone",
		"US: CNN (East)":   "cnn",
		"UK | BBC One":     "bbcone",
		"Canal+ Sport":     "canalplussport",
		"Télé-Québec":      "telequebec",
		"4K":               "4k",
		"":                 "",
		"   ":              "",
		" BBC One HD ":     "bbcone",
		"BBC One [HD]":     "bbcone",
		"Discovery 1080p":  "discovery",
		"Sky Sports F1 HD": "skysportsf1",
		"BBC & ITV":        "bbcanditv",
	}
	for name, want := range cases {
		if got := NormaliseName(name); got != want {
			t.Errorf("NormaliseName(%q) = %q, want %q", name, got, want)
		}
	}
}

// matcherChannel is a playlist channel with just the fields the matcher reads.
func matcherChannel(id, tvgID, name string) Channel {
	return Channel{ID: id, TvgID: tvgID, Name: name}
}

func TestResolve(t *testing.T) {
	t.Run("tvg-id is case-insensitive", func(t *testing.T) {
		m := NewMatcher([]Channel{matcherChannel("ours:1", "BBC1.UK", "BBC One")})
		got := m.Resolve([]GuideChannel{{ID: "bbc1.uk", Names: []string{"BBC One"}}})
		want := map[string][]string{"bbc1.uk": {"ours:1"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Resolve = %v, want %v", got, want)
		}
	})

	t.Run("names are the fallback", func(t *testing.T) {
		// The playlist entry carries no tvg-id, so only the name can match it,
		// and the HD suffix must not get in the way.
		m := NewMatcher([]Channel{matcherChannel("ours:1", "", "BBC One HD")})
		got := m.Resolve([]GuideChannel{{ID: "bbc1.uk", Names: []string{"BBC One"}}})
		want := map[string][]string{"bbc1.uk": {"ours:1"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Resolve = %v, want %v", got, want)
		}
	})

	t.Run("names skip what a tvg-id already matched", func(t *testing.T) {
		m := NewMatcher([]Channel{matcherChannel("ours:1", "bbc1.uk", "BBC One")})
		got := m.Resolve([]GuideChannel{
			{ID: "bbc1.uk", Names: []string{"BBC One"}},
			{ID: "bbc1.uk.hd", Names: []string{"BBC One"}},
		})
		want := map[string][]string{"bbc1.uk": {"ours:1"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Resolve = %v, want %v", got, want)
		}
	})

	t.Run("names skip a channel another guide channel owns", func(t *testing.T) {
		m := NewMatcher([]Channel{matcherChannel("ours:2", "bbc2.uk", "BBC One")})
		got := m.Resolve([]GuideChannel{
			{ID: "bbc1.uk", Names: []string{"BBC One"}},
			{ID: "bbc2.uk", Names: []string{"BBC Two"}},
		})
		want := map[string][]string{"bbc2.uk": {"ours:2"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Resolve = %v, want %v", got, want)
		}
	})

	t.Run("several channels can share a tvg-id", func(t *testing.T) {
		m := NewMatcher([]Channel{
			matcherChannel("ours:1", "bbc1.uk", "BBC One"),
			matcherChannel("ours:2", "bbc1.uk", "BBC One London"),
		})
		got := m.Resolve([]GuideChannel{{ID: "bbc1.uk"}})
		want := map[string][]string{"bbc1.uk": {"ours:1", "ours:2"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Resolve = %v, want %v", got, want)
		}
	})

	t.Run("names keep the playlist's order", func(t *testing.T) {
		m := NewMatcher([]Channel{
			matcherChannel("ours:b", "", "BBC One"),
			matcherChannel("ours:a", "", "BBC One"),
		})
		got := m.Resolve([]GuideChannel{{ID: "bbc1.uk", Names: []string{"BBC One", "BBC1"}}})
		want := map[string][]string{"bbc1.uk": {"ours:b", "ours:a"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Resolve = %v, want %v", got, want)
		}
	})

	t.Run("unmatched guide channels are left out", func(t *testing.T) {
		m := NewMatcher([]Channel{matcherChannel("ours:1", "bbc1.uk", "BBC One")})
		got := m.Resolve([]GuideChannel{
			{ID: "bbc1.uk"},
			{ID: "us.cnn", Names: []string{"CNN"}},
		})
		want := map[string][]string{"bbc1.uk": {"ours:1"}}
		if !reflect.DeepEqual(got, want) {
			t.Fatalf("Resolve = %v, want %v", got, want)
		}
	})
}

func TestByTvgID(t *testing.T) {
	m := NewMatcher([]Channel{
		matcherChannel("ours:1", "bbc1.uk", "BBC One"),
		matcherChannel("ours:2", " BBC1.UK ", "BBC One London"),
		matcherChannel("ours:3", "", "Dave"),
	})

	got := m.ByTvgID("bbc1.uk")
	want := []string{"ours:1", "ours:2"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("ByTvgID = %v, want %v", got, want)
	}
	if got := m.ByTvgID("dave.uk"); got != nil {
		t.Errorf("ByTvgID of an unknown id = %v, want nil", got)
	}
	if got := m.ByTvgID("  "); got != nil {
		t.Errorf("ByTvgID of a blank id = %v, want nil", got)
	}
}
