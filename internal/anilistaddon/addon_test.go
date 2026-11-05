package anilistaddon

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/k22i/Sinag/internal/anilist"
	"github.com/k22i/Sinag/internal/animelist"
)

// Frieren maps to Kitsu; the second title has no Kitsu id yet.
var entries = []animelist.Entry{
	{AniList: 154587, Kitsu: 46474, IMDb: []string{"tt22248376"}, Type: "TV"},
	{AniList: 999001, Type: "TV"},
}

type fake struct {
	anilist, kitsu *httptest.Server
	queries        atomic.Int32
	vars           atomic.Pointer[map[string]any]
	status         int
}

func newFake(t *testing.T) (*fake, *Addon) {
	t.Helper()
	f := &fake{}
	f.anilist = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.queries.Add(1)
		var body struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.vars.Store(&body.Variables)
		if f.status != 0 {
			w.Header().Set("Retry-After", "60")
			w.WriteHeader(f.status)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		if strings.Contains(body.Query, "Page(") {
			_, _ = io.WriteString(w, `{"data":{"Page":{"pageInfo":{"hasNextPage":true},"media":[
				{"id":154587,"format":"TV","status":"FINISHED","title":{"romaji":"Sousou no Frieren","english":"Frieren: Beyond Journey's End"},
				 "description":"An elf<br><br>and <i>her</i> friends &amp; more","startDate":{"year":2023,"month":9,"day":29},"endDate":{"year":2024,"month":3,"day":22},
				 "genres":["Adventure","Drama"],"averageScore":90,"coverImage":{"extraLarge":"https://img/frieren.jpg"},"bannerImage":"https://img/banner.jpg"},
				{"id":999001,"format":"MOVIE","status":"RELEASING","title":{"romaji":"Shin Eiga"},"startDate":{"year":2026},"coverImage":{"large":"https://img/l.jpg"}}
			]}}}`)
			return
		}
		id, _ := body.Variables["id"].(float64)
		if id != 154587 && id != 999001 {
			_, _ = io.WriteString(w, `{"data":{"Media":null},"errors":[{"message":"Not Found.","status":404}]}`)
			return
		}
		_, _ = io.WriteString(w, `{"data":{"Media":{"id":154587,"format":"TV","status":"RELEASING","title":{"english":"Frieren"},
			"episodes":3,"duration":24,"countryOfOrigin":"JP","siteUrl":"https://anilist.co/anime/154587",
			"studios":{"nodes":[{"name":"Madhouse","siteUrl":"https://anilist.co/studio/11"}]},
			"trailer":{"id":"yt123","site":"youtube"},
			"nextAiringEpisode":{"episode":3,"airingAt":1893456000},
			"upcoming":{"nodes":[{"episode":3,"airingAt":1893456000}]},
			"aired":{"nodes":[{"episode":2,"airingAt":1893000000}]}}}}`)
	}))
	t.Cleanup(f.anilist.Close)
	f.kitsu = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/anime/46474/episodes" {
			http.NotFound(w, r)
			return
		}
		_, _ = io.WriteString(w, `{"data":[
			{"attributes":{"number":1,"canonicalTitle":"The Journey's End","airdate":"2023-09-29","synopsis":"First.","thumbnail":{"original":"https://img/e1.jpg"}}},
			{"attributes":{"number":2,"titles":{"en_us":"It Didn't Have to Be Magic"},"airdate":"2023-09-29"}}
		],"meta":{"count":2}}`)
	}))
	t.Cleanup(f.kitsu.Close)
	a := New(anilist.New(f.anilist.URL, "test"), animelist.FromEntries(entries), f.kitsu.URL, "1.0.0")
	return f, a
}

func get(t *testing.T, a *Addon, path string) (int, map[string]any) {
	t.Helper()
	rec := httptest.NewRecorder()
	a.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, "sinag://anilist"+path, nil))
	var out map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &out); err != nil {
		t.Fatalf("%s: %v (%s)", path, err, rec.Body)
	}
	return rec.Code, out
}

func TestManifest(t *testing.T) {
	_, a := newFake(t)
	code, m := get(t, a, "/manifest.json")
	if code != 200 || m["id"] != "sinag.anilist" {
		t.Fatalf("manifest = %d %v", code, m)
	}
	catalogs := m["catalogs"].([]any)
	if len(catalogs) != len(lists)+1 {
		t.Fatalf("%d catalogs", len(catalogs))
	}
	for _, c := range catalogs {
		if c.(map[string]any)["type"] != "anime" {
			t.Errorf("catalog %v isn't typed anime", c)
		}
	}
}

func TestCatalog(t *testing.T) {
	f, a := newFake(t)
	code, out := get(t, a, "/catalog/anime/season/genre=Slice%20of%20Life&skip=50.json")
	if code != 200 {
		t.Fatalf("status %d: %v", code, out)
	}
	vars := *f.vars.Load()
	if vars["page"] != float64(2) || vars["genre"] != "Slice of Life" || vars["season"] == nil {
		t.Errorf("variables = %v", vars)
	}
	metas := out["metas"].([]any)
	first, second := metas[0].(map[string]any), metas[1].(map[string]any)
	if first["id"] != "kitsu:46474" || first["type"] != "series" || first["name"] != "Frieren: Beyond Journey's End" {
		t.Errorf("first = %v", first)
	}
	if first["description"] != "An elf\n\nand her friends & more" || first["releaseInfo"] != "2023–2024" || first["imdbRating"] != "9.0" {
		t.Errorf("first = %v", first)
	}
	if second["id"] != "anilist:999001" || second["type"] != "movie" || second["poster"] != "https://img/l.jpg" {
		t.Errorf("second = %v", second)
	}
	if out["hasMore"] != true {
		t.Error("hasMore")
	}

	// Kept: the same page asks AniList once.
	before := f.queries.Load()
	get(t, a, "/catalog/anime/season/genre=Slice%20of%20Life&skip=50.json")
	if f.queries.Load() != before {
		t.Error("asked AniList again for a kept page")
	}
	if code, _ := get(t, a, "/catalog/anime/nope.json"); code != 404 {
		t.Errorf("unknown list: %d", code)
	}
}

func TestSeasonOf(t *testing.T) {
	for _, c := range []struct {
		month      time.Month
		next       bool
		season     string
		yearOffset int
	}{
		{time.January, false, "WINTER", 0}, {time.May, false, "SPRING", 0},
		{time.November, false, "FALL", 0}, {time.November, true, "WINTER", 1},
	} {
		season, year := seasonOf(time.Date(2026, c.month, 5, 0, 0, 0, 0, time.UTC), c.next)
		if season != c.season || year != 2026+c.yearOffset {
			t.Errorf("seasonOf(%s, %v) = %s %d", c.month, c.next, season, year)
		}
	}
}

func TestMeta(t *testing.T) {
	_, a := newFake(t)
	code, out := get(t, a, "/meta/series/kitsu%3A46474.json")
	if code != 200 {
		t.Fatalf("status %d: %v", code, out)
	}
	meta := out["meta"].(map[string]any)
	if meta["id"] != "kitsu:46474" || meta["runtime"] != "24 min" || meta["releaseInfo"] != "2023–" {
		t.Errorf("meta = %v", meta)
	}
	videos := meta["videos"].([]any)
	if len(videos) != 3 {
		t.Fatalf("%d videos", len(videos))
	}
	v1, v2, v3 := videos[0].(map[string]any), videos[1].(map[string]any), videos[2].(map[string]any)
	if v1["id"] != "kitsu:46474:1" || v1["title"] != "The Journey's End" || v1["thumbnail"] != "https://img/e1.jpg" ||
		v1["released"] != "2023-09-29T00:00:00.000Z" || v1["season"] != float64(1) || v1["episode"] != float64(1) {
		t.Errorf("episode 1 = %v", v1)
	}
	// AniList's airing time wins over Kitsu's date.
	if v2["title"] != "It Didn't Have to Be Magic" || v2["released"] != time.Unix(1893000000, 0).UTC().Format("2006-01-02T15:04:05.000Z") {
		t.Errorf("episode 2 = %v", v2)
	}
	if v3["title"] != "Episode 3" || v3["released"] != time.Unix(1893456000, 0).UTC().Format("2006-01-02T15:04:05.000Z") {
		t.Errorf("episode 3 = %v", v3)
	}
	if trailers := meta["trailerStreams"].([]any); trailers[0].(map[string]any)["ytId"] != "yt123" {
		t.Errorf("trailers = %v", trailers)
	}

	// A Kitsu id the list can't map is the next addon's to answer.
	if code, _ := get(t, a, "/meta/series/kitsu%3A1.json"); code != 404 {
		t.Errorf("unmapped Kitsu id: %d", code)
	}
	if code, _ := get(t, a, "/meta/series/tt22248376.json"); code != 404 {
		t.Errorf("IMDb id: %d", code)
	}
}

func TestRateLimited(t *testing.T) {
	f, a := newFake(t)
	f.status = http.StatusTooManyRequests
	if code, _ := get(t, a, "/catalog/anime/trending.json"); code != 503 {
		t.Fatalf("status %d, want 503", code)
	}
	// AniList isn't asked again until Retry-After has passed.
	before := f.queries.Load()
	if code, _ := get(t, a, "/catalog/anime/top.json"); code != 503 || f.queries.Load() != before {
		t.Errorf("asked AniList while told to wait")
	}
}
