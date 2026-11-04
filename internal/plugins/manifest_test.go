package plugins

import "testing"

func TestParseManifestList(t *testing.T) {
	data := `[
		{"id": "one", "name": "One", "supportedTypes": ["movie", "tv"], "filename": "providers/one.js", "enabled": true},
		{"id": "two", "filename": "https://other.test/two.js", "enabled": false, "supportedTypes": ["movie"]},
		{"id": "mobile", "filename": "providers/m.js", "enabled": true, "disabledPlatforms": ["desktop"]},
		{"id": "", "filename": "providers/none.js"},
		{"id": "nofile"},
		{"id": "ftp", "filename": "ftp://x.test/a.js"}
	]`
	m, err := ParseManifest([]byte(data), "https://raw.test/user/repo/main/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Scrapers) != 2 {
		t.Fatalf("got %+v", m.Scrapers)
	}
	if got := m.Scrapers[0]; got.File != "https://raw.test/user/repo/main/providers/one.js" || got.Name != "One" || !got.Enabled {
		t.Errorf("one: %+v", got)
	}
	if got := m.Scrapers[1]; got.File != "https://other.test/two.js" || got.Name != "two" || got.Enabled {
		t.Errorf("two: %+v", got)
	}
}

func TestParseManifestObject(t *testing.T) {
	data := `{"name": "Repo", "version": "2.0.0", "scrapers": [
		{"id": "anime", "name": "Anime", "supportedTypes": ["anime", "tv"], "filename": "providers/a.js", "enabled": true}
	]}`
	m, err := ParseManifest([]byte(data), "https://raw.test/repo/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if m.Name != "Repo" || len(m.Scrapers) != 1 || m.Scrapers[0].File != "https://raw.test/repo/providers/a.js" {
		t.Errorf("got %+v", m)
	}
	if _, err := ParseManifest([]byte(`"nope"`), "https://raw.test/"); err == nil {
		t.Error("a string parsed as a manifest")
	}
}

func TestServes(t *testing.T) {
	for _, tc := range []struct {
		types []string
		media string
		want  bool
	}{
		{[]string{"movie"}, "movie", true},
		{[]string{"movie"}, "tv", false},
		{[]string{"tv"}, "tv", true},
		{[]string{"series"}, "tv", true},
		{[]string{"anime"}, "tv", true},
		{[]string{"Movie"}, "movie", true},
		{nil, "movie", true},
	} {
		if got := (Scraper{SupportedTypes: tc.types}).Serves(tc.media); got != tc.want {
			t.Errorf("%v serves %s = %v", tc.types, tc.media, got)
		}
	}
}
