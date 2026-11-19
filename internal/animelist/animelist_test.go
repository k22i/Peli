package animelist

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"
)

// Rows as anime-list-mini.json has them: a show split into two cours on
// TVDB's season 3, its film, and a Kitsu-only entry.
const mini = `[
 {"type":"TV","anilist_id":20958,"kitsu_id":8671,"mal_id":25777,"imdb_id":["tt2560140"],"season":{"tvdb":2}},
 {"type":"TV","anilist_id":99147,"kitsu_id":13569,"mal_id":35760,"imdb_id":["tt2560140"],"season":{"tvdb":3,"tmdb":3}},
 {"type":"TV","anilist_id":104578,"kitsu_id":41982,"mal_id":38524,"imdb_id":["tt2560140"],"season":{"tvdb":3},"episode_offset":{"tvdb":12}},
 {"type":"MOVIE","anilist_id":21827,"kitsu_id":11211,"imdb_id":["tt5311514"]},
 {"type":"OVA","anilist_id":1,"kitsu_id":2},
 {"type":"TV","mal_id":3}
]`

func TestFind(t *testing.T) {
	entries, err := parse([]byte(mini))
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 5 {
		t.Fatalf("%d entries: a row without an AniList id is skipped", len(entries))
	}
	l := FromEntries(entries)
	ctx := context.Background()
	for _, tc := range []struct {
		name    string
		ref     Ref
		anilist int
		episode int
	}{
		{"Kitsu", Ref{Kitsu: 13569, Episode: 5}, 99147, 5},
		{"MyAnimeList", Ref{MAL: 25777, Episode: 1}, 20958, 1},
		{"AniList as it is", Ref{AniList: 555, Episode: 2}, 555, 2},
		{"IMDb, the first cour", Ref{IMDb: "tt2560140", Season: 3, Episode: 12}, 99147, 12},
		{"IMDb, the second cour", Ref{IMDb: "tt2560140", Season: 3, Episode: 13}, 104578, 1},
		{"IMDb film", Ref{IMDb: "tt5311514"}, 21827, 1},
	} {
		entry, episode, ok := l.Find(ctx, tc.ref)
		if !ok || entry.AniList != tc.anilist || episode != tc.episode {
			t.Errorf("%s: Find = %d episode %d, %v; want %d episode %d", tc.name, entry.AniList, episode, ok, tc.anilist, tc.episode)
		}
	}
	if _, _, ok := l.Find(ctx, Ref{IMDb: "tt2560140", Season: 9, Episode: 1}); ok {
		t.Error("found a season the list doesn't have")
	}
	if !l.IsAnime(ctx, "tt5311514") || l.IsAnime(ctx, "tt0903747") {
		t.Error("IsAnime")
	}
	if e, ok := l.ByAniList(ctx, 104578); !ok || e.Kitsu != 41982 || e.Offset != 12 || *e.Season != 3 {
		t.Errorf("ByAniList = %+v, %v", e, ok)
	}
}

// The list is downloaded once and kept; a week later it's downloaded
// again, and a failed download keeps the copy it has.
func TestDownloadAndKeep(t *testing.T) {
	var gets atomic.Int32
	down := atomic.Bool{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		gets.Add(1)
		if down.Load() {
			http.Error(w, "down", http.StatusBadGateway)
			return
		}
		_, _ = w.Write([]byte(mini))
	}))
	defer srv.Close()
	dir := t.TempDir()
	clock := time.Unix(1_800_000_000, 0)
	l := New(srv.URL, dir)
	l.now = func() time.Time { return clock }

	if !l.IsAnime(context.Background(), "tt2560140") || gets.Load() != 1 {
		t.Fatalf("first use: %d downloads", gets.Load())
	}
	if _, err := os.Stat(filepath.Join(dir, "anime-list.json")); err != nil {
		t.Fatal(err)
	}
	l.IsAnime(context.Background(), "tt2560140")
	if gets.Load() != 1 {
		t.Fatal("downloaded again within the week")
	}

	clock = clock.Add(RefreshEvery)
	down.Store(true)
	if !l.IsAnime(context.Background(), "tt2560140") || gets.Load() != 2 {
		t.Fatalf("after a week: %d downloads, the old copy still answers", gets.Load())
	}

	// A new run reads the kept copy, with no network.
	again := New("", dir)
	if !again.IsAnime(context.Background(), "tt5311514") {
		t.Fatal("the kept copy wasn't read")
	}
}

func TestLeaveOut(t *testing.T) {
	l := FromEntries([]Entry{
		{AniList: 1, IMDb: []string{"tt2", "tt1"}},
		{AniList: 2, IMDb: []string{"tt1"}},
		{AniList: 3},
	})
	got := NewService(l).LeaveOut(t.Context(), []string{"tt1", "tt3", "tt2:1:4", "kitsu:1"})
	if !got.Ready || len(got.Anime) != 4 || !got.Anime[0] || got.Anime[1] || !got.Anime[2] || got.Anime[3] {
		t.Errorf("LeaveOut = %+v", got)
	}
}

// A show's first season and a show with films filed as its specials take
// the show's poster; later seasons, second cours, specials and entries
// that can't be told apart keep AniList's cover.
func TestPosterTitle(t *testing.T) {
	entries, err := parse([]byte(`[
 {"type":"OVA","anilist_id":87528,"kitsu_id":12625,"imdb_id":["tt7441658"],"season":{"tvdb":0}},
 {"type":"TV","anilist_id":97940,"kitsu_id":13209,"imdb_id":["tt7441658"],"season":{"tvdb":1}},
 {"type":"TV","anilist_id":195604,"kitsu_id":50024,"imdb_id":["tt7441658"],"season":{"tvdb":2}},
 {"type":"TV","anilist_id":1735,"kitsu_id":1555,"imdb_id":["tt0988824"]},
 {"type":"MOVIE","anilist_id":10686,"kitsu_id":6292,"imdb_id":["tt0988824"],"season":{"tvdb":0}},
 {"type":"TV","anilist_id":20958,"imdb_id":["tt2560140"],"season":{"tvdb":1}},
 {"type":"TV","anilist_id":104578,"imdb_id":["tt2560140"],"season":{"tvdb":1},"episode_offset":{"tvdb":12}},
 {"type":"MOVIE","anilist_id":21827,"imdb_id":["tt5311514"]},
 {"type":"TV","anilist_id":1,"imdb_id":["tt0000001"]},
 {"type":"ONA","anilist_id":2,"imdb_id":["tt0000001"]}
]`))
	if err != nil {
		t.Fatal(err)
	}
	l := FromEntries(entries)
	ctx := context.Background()
	for _, tc := range []struct {
		id   string
		want PosterTitle
	}{
		{"anilist:97940", PosterTitle{"tt7441658", "series"}},
		{"kitsu:13209", PosterTitle{"tt7441658", "series"}},
		{"anilist:195604", PosterTitle{}},
		{"anilist:87528", PosterTitle{}},
		{"kitsu:1555", PosterTitle{"tt0988824", "series"}},
		{"anilist:10686", PosterTitle{}},
		{"anilist:20958", PosterTitle{"tt2560140", "series"}},
		{"anilist:104578", PosterTitle{}},
		{"anilist:21827", PosterTitle{"tt5311514", "movie"}},
		{"anilist:1", PosterTitle{}},
		{"anilist:404", PosterTitle{}},
	} {
		if got, _ := l.PosterTitle(ctx, tc.id); got != tc.want {
			t.Errorf("%s: PosterTitle = %+v; want %+v", tc.id, got, tc.want)
		}
	}
}
