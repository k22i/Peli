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
	// The old copy answers at once; the new download runs behind it.
	if !l.IsAnime(context.Background(), "tt2560140") {
		t.Fatal("after a week: the old copy didn't answer")
	}
	for deadline := time.Now().Add(5 * time.Second); gets.Load() < 2 && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
	if gets.Load() != 2 {
		t.Fatalf("after a week: %d downloads, want 2", gets.Load())
	}
	// The failed download is over before the old copy is asked again.
	for deadline := time.Now().Add(5 * time.Second); l.warming.Load() && time.Now().Before(deadline); {
		time.Sleep(5 * time.Millisecond)
	}
	if !l.IsAnime(context.Background(), "tt2560140") {
		t.Fatal("after the failed download: the old copy stopped answering")
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

// Every season and cour of a show belongs to the show's IMDb title, at its
// season; a film with an IMDb id of its own is that film; specials, OVAs and
// films filed as a show's season 0 stay AniList's, as does a film whose IMDb
// id a show's season also has.
func TestTitle(t *testing.T) {
	entries, err := parse([]byte(`[
 {"type":"OVA","anilist_id":87528,"kitsu_id":12625,"imdb_id":["tt7441658"],"season":{"tvdb":0},"themoviedb_id":{"tv":73223}},
 {"type":"TV","anilist_id":97940,"kitsu_id":13209,"imdb_id":["tt7441658"],"season":{"tvdb":1},"themoviedb_id":{"tv":73223}},
 {"type":"TV","anilist_id":195604,"kitsu_id":50024,"imdb_id":["tt7441658"],"season":{"tvdb":2},"themoviedb_id":{"tv":73223}},
 {"type":"TV","anilist_id":1735,"kitsu_id":1555,"imdb_id":["tt0988824"],"themoviedb_id":{"tv":31910}},
 {"type":"MOVIE","anilist_id":10686,"kitsu_id":6292,"imdb_id":["tt0988824"],"season":{"tvdb":0},"themoviedb_id":{"tv":31910}},
 {"type":"TV","anilist_id":20958,"imdb_id":["tt2560140"],"season":{"tvdb":1}},
 {"type":"TV","anilist_id":104578,"imdb_id":["tt2560140"],"season":{"tvdb":1},"episode_offset":{"tvdb":12}},
 {"type":"MOVIE","anilist_id":21827,"imdb_id":["tt5311514"]},
 {"type":"MOVIE","anilist_id":112151,"imdb_id":["tt11032374"],"season":{"tvdb":0},"themoviedb_id":{"movie":[635302]}},
 {"type":"ONA","anilist_id":195539,"imdb_id":["tt12590266"],"season":{"tvdb":2},"themoviedb_id":{"tv":105248}},
 {"type":"OVA","anilist_id":270,"imdb_id":["tt0495212"],"season":{"tvdb":1},"themoviedb_id":{"tv":13916}},
 {"type":"MOVIE","anilist_id":3,"imdb_id":["tt0000003"],"themoviedb_id":{"movie":[1]}},
 {"type":"TV","anilist_id":4,"imdb_id":["tt0000003"],"season":{"tvdb":1}},
 {"type":"TV","anilist_id":5,"imdb_id":["tt0000005","tt0000006"]},
 {"type":"TV","anilist_id":6,"imdb_id":["tt0000007"],"themoviedb_id":17}
]`))
	if err != nil {
		t.Fatal(err)
	}
	l := FromEntries(entries)
	ctx := context.Background()
	for _, tc := range []struct {
		id   string
		want Title
	}{
		{"anilist:97940", Title{"tt7441658", "series", 1}},
		{"kitsu:13209", Title{"tt7441658", "series", 1}},
		{"anilist:195604", Title{"tt7441658", "series", 2}},
		{"kitsu:50024", Title{"tt7441658", "series", 2}},
		{"anilist:87528", Title{}},
		{"kitsu:1555", Title{"tt0988824", "series", 0}},
		{"anilist:10686", Title{}},
		{"anilist:20958", Title{"tt2560140", "series", 1}},
		{"anilist:104578", Title{"tt2560140", "series", 1}},
		{"anilist:21827", Title{"tt5311514", "movie", 0}},
		{"anilist:112151", Title{"tt11032374", "movie", 0}},
		{"anilist:195539", Title{"tt12590266", "series", 2}},
		{"anilist:270", Title{"tt0495212", "series", 1}},
		{"anilist:3", Title{}},
		{"anilist:4", Title{"tt0000003", "series", 1}},
		{"anilist:5", Title{}},
		{"anilist:6", Title{"tt0000007", "series", 0}},
		{"anilist:404", Title{}},
		{"tvdb:1", Title{}},
	} {
		if got, _ := l.Title(ctx, tc.id); got != tc.want {
			t.Errorf("%s: Title = %+v; want %+v", tc.id, got, tc.want)
		}
	}
}
