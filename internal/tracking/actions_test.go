package tracking

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"testing"

	"github.com/k22i/Peli/internal/simkl/simkltest"
)

func js(v any) string {
	data, _ := json.Marshal(v)
	return string(data)
}

var (
	breakingBad = TitleRef{Type: "series", ID: "tt0903747", Name: "Breaking Bad", Year: 2008, IDs: map[string]string{"tmdb": "1396"}}
	theMatrix   = TitleRef{Type: "movie", ID: "tt0133093", Name: "The Matrix", Year: 1999}
	frierenRef  = TitleRef{Type: "series", ID: "tt22248376", Name: "Frieren"}
)

func TestSetStatusSimkl(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	ctx := context.Background()

	got, err := f.s.SetStatus(ctx, f.profile.ID, breakingBad, StatusWatching)
	check(t, err)
	if got.Status != StatusWatching || got.Queued {
		t.Fatalf("got %+v", got)
	}
	posts := f.simkl.Writes("/sync/add-to-list")
	if len(posts) != 1 || js(posts[0]) != `{"shows":[{"ids":{"imdb":"tt0903747","tmdb":"1396"},"title":"Breaking Bad","to":"watching","year":2008}]}` {
		t.Fatalf("posts = %v", posts)
	}

	// A film is planned, completed or dropped; SIMKL has no watching film.
	if _, err := f.s.SetStatus(ctx, f.profile.ID, theMatrix, StatusWatching); !errors.Is(err, ErrNotTrackable) {
		t.Fatalf("watching film: err = %v", err)
	}
	if _, err := f.s.SetStatus(ctx, f.profile.ID, theMatrix, StatusPlanned); err != nil {
		t.Fatal(err)
	}
	posts = f.simkl.Writes("/sync/add-to-list")
	if len(posts) != 2 || !strings.Contains(js(posts[1]), `"movies":[{"ids":{"imdb":"tt0133093"},"title":"The Matrix","to":"plantowatch","year":1999}]`) {
		t.Fatalf("posts = %v", posts)
	}

	if _, err := f.s.SetStatus(ctx, f.profile.ID, theMatrix, "binge"); !errors.Is(err, ErrBadStatus) {
		t.Fatalf("bad status: err = %v", err)
	}

	// None takes it off the lists, which SIMKL only does through history.
	got, err = f.s.SetStatus(ctx, f.profile.ID, breakingBad, StatusNone)
	check(t, err)
	removed := f.simkl.Writes("/sync/history/remove")
	if got.Status != StatusNone || len(removed) != 1 || js(removed[0]) != `{"shows":[{"ids":{"imdb":"tt0903747","tmdb":"1396"}}]}` {
		t.Fatalf("got %+v, removed %v", got, removed)
	}
}

func TestSetStatusAnimeKeepsToAnimeIDs(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	ref := TitleRef{Type: "series", ID: "kitsu:46474", Name: "Frieren"}
	_, err := f.s.SetStatus(context.Background(), f.profile.ID, ref, StatusPlanned)
	check(t, err)
	posts := f.simkl.Writes("/sync/add-to-list")
	if len(posts) != 1 || js(posts[0]) != `{"anime":[{"ids":{"kitsu":"46474"},"title":"Frieren","to":"plantowatch"}]}` {
		t.Fatalf("posts = %v", posts)
	}
}

func TestSetRatingSimkl(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	ctx := context.Background()
	got, err := f.s.SetRating(ctx, f.profile.ID, theMatrix, 9)
	check(t, err)
	posts := f.simkl.Writes("/sync/ratings")
	if got.Rating != 9 || len(posts) != 1 || js(posts[0]) != `{"movies":[{"ids":{"imdb":"tt0133093"},"rating":9}]}` {
		t.Fatalf("got %+v, posts %v", got, posts)
	}
	got, err = f.s.SetRating(ctx, f.profile.ID, theMatrix, 0)
	check(t, err)
	cleared := f.simkl.Writes("/sync/ratings/remove")
	if got.Rating != 0 || len(cleared) != 1 || js(cleared[0]) != `{"movies":[{"ids":{"imdb":"tt0133093"}}]}` {
		t.Fatalf("got %+v, cleared %v", got, cleared)
	}
	if _, err := f.s.SetRating(ctx, f.profile.ID, theMatrix, 11); !errors.Is(err, ErrBadStatus) {
		t.Fatalf("err = %v", err)
	}
}

func TestTitleStatusReadsSimklLists(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	f.simkl.Set(func(s *simkltest.Server) {
		s.Library["shows"] = map[string]any{"shows": []any{
			map[string]any{"status": "hold", "user_rating": 7,
				"show": map[string]any{"title": "Breaking Bad", "year": 2008, "ids": map[string]any{"simkl": 11121, "imdb": "tt0903747", "tmdb": "1396"}}},
		}}
	})
	ctx := context.Background()
	got, err := f.s.TitleStatus(ctx, f.profile.ID, breakingBad)
	check(t, err)
	if got.Status != StatusPaused || got.Rating != 7 || js(got.Services) != `["simkl"]` {
		t.Fatalf("got %+v", got)
	}
	// Asked again, it comes from the copy; a title that isn't listed is none.
	got, err = f.s.TitleStatus(ctx, f.profile.ID, TitleRef{Type: "series", ID: "tt0000001"})
	check(t, err)
	if got.Status != StatusNone || got.Rating != 0 || len(got.Services) != 0 {
		t.Fatalf("got %+v", got)
	}
	if calls := f.simkl.LibraryCalls; len(calls) != 1 {
		t.Fatalf("library calls = %v", calls)
	}
	// A write drops the copy.
	_, err = f.s.SetStatus(ctx, f.profile.ID, breakingBad, StatusCompleted)
	check(t, err)
	if calls := f.simkl.LibraryCalls; len(calls) != 2 {
		t.Fatalf("library calls after a write = %v", calls)
	}
}

func TestTitleStatusWithNoConnection(t *testing.T) {
	f := setup(t)
	got, err := f.s.TitleStatus(context.Background(), f.profile.ID, breakingBad)
	check(t, err)
	if got.Status != StatusNone {
		t.Fatalf("got %+v", got)
	}
	if _, err := f.s.SetStatus(context.Background(), f.profile.ID, breakingBad, StatusPlanned); !errors.Is(err, ErrNotConnected) {
		t.Fatalf("err = %v", err)
	}
}

func TestTitleStatusFailsSoftWhenSimklIsDown(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	f.simkl.Set(func(s *simkltest.Server) { s.Down = true })
	_, err := f.s.TitleStatus(context.Background(), f.profile.ID, breakingBad)
	if err == nil || string(MarshalError(err)) != `{"code":"unavailable"}` {
		t.Fatalf("err = %v", err)
	}
}

func TestAniListStatusRatingAndRemoval(t *testing.T) {
	f := setup(t)
	f.connectAniList(t)
	ctx := context.Background()

	got, err := f.s.SetStatus(ctx, f.profile.ID, frierenRef, StatusPlanned)
	check(t, err)
	if got.Status != StatusPlanned || js(got.Services) != `["anilist"]` {
		t.Fatalf("got %+v", got)
	}
	got, err = f.s.SetRating(ctx, f.profile.ID, frierenRef, 8)
	check(t, err)
	if got.Rating != 8 || got.Status != StatusPlanned {
		t.Fatalf("got %+v", got)
	}
	want := "154587:0:PLANNING:0 154587:0:PLANNING:80"
	if strings.Join(f.ani.saved, " ") != want {
		t.Fatalf("saved = %v, want %s", f.ani.saved, want)
	}
	// In order (not a map, whose order is random): dropped is set last.
	for _, c := range []struct{ status, anilist string }{
		{StatusWatching, "CURRENT"}, {StatusCompleted, "COMPLETED"}, {StatusPaused, "PAUSED"}, {StatusDropped, "DROPPED"},
	} {
		_, err = f.s.SetStatus(ctx, f.profile.ID, frierenRef, c.status)
		check(t, err)
		if f.ani.entries[154587].Status != c.anilist {
			t.Fatalf("%s saved as %s", c.status, f.ani.entries[154587].Status)
		}
	}
	// Rating and status are kept as set.
	got, err = f.s.TitleStatus(ctx, f.profile.ID, frierenRef)
	check(t, err)
	if got.Status != StatusDropped || got.Rating != 8 {
		t.Fatalf("got %+v", got)
	}
	// Clearing the rating saves a score of 0; none deletes the entry.
	_, err = f.s.SetRating(ctx, f.profile.ID, frierenRef, 0)
	check(t, err)
	if f.ani.entries[154587].Score != 0 {
		t.Fatalf("entry = %+v", f.ani.entries[154587])
	}
	got, err = f.s.SetStatus(ctx, f.profile.ID, frierenRef, StatusNone)
	check(t, err)
	if got.Status != StatusNone || f.ani.entries[154587] != nil || !strings.HasPrefix(f.ani.saved[len(f.ani.saved)-1], "delete:") {
		t.Fatalf("got %+v, saved %v", got, f.ani.saved)
	}
	// Not anime: AniList has nothing to do with it.
	if _, err := f.s.SetStatus(ctx, f.profile.ID, breakingBad, StatusPlanned); !errors.Is(err, ErrNotTrackable) {
		t.Fatalf("err = %v", err)
	}
}

func TestWatchlistMergesServices(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	f.connectAniList(t)
	f.simkl.Set(func(s *simkltest.Server) {
		s.Library["movies/plantowatch"] = map[string]any{"movies": []any{
			map[string]any{"status": "plantowatch", "movie": map[string]any{"title": "The Matrix", "year": 1999, "poster": "12/1234", "ids": map[string]any{"simkl": 1, "imdb": "tt0133093"}}},
		}}
		s.Library["anime/plantowatch"] = map[string]any{"anime": []any{
			// Frieren is on AniList's planning list too: one entry.
			map[string]any{"status": "plantowatch", "anime_type": "tv", "show": map[string]any{"title": "Sousou no Frieren", "year": 2023, "ids": map[string]any{"simkl": 2, "mal": "52991"}}},
			map[string]any{"status": "plantowatch", "anime_type": "movie", "show": map[string]any{"title": "Weathering", "ids": map[string]any{"simkl": 3, "kitsu": "13209"}}},
		}}
	})
	list, err := f.s.Watchlist(context.Background(), f.profile.ID)
	check(t, err)
	var got []string
	for _, item := range list {
		got = append(got, item.ID+"|"+item.Type+"|"+item.Name+"|"+strings.Join(item.Services, "+")+"|"+item.Poster)
	}
	want := []string{
		"tt0133093|movie|The Matrix|simkl|https://simkl.in/posters/12/1234_m.webp",
		"mal:52991|series|Sousou no Frieren|simkl+anilist|https://img.example/frieren.jpg",
		"kitsu:13209|movie|Weathering|simkl|",
	}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Fatalf("watchlist =\n%s", strings.Join(got, "\n"))
	}
	if list[1].IDs["imdb"] != "tt22248376" || list[1].IDs["anilist"] != "154587" {
		t.Fatalf("merged ids = %v", list[1].IDs)
	}
}

func TestWatchlistFromAniListAlone(t *testing.T) {
	f := setup(t)
	f.connectAniList(t)
	list, err := f.s.Watchlist(context.Background(), f.profile.ID)
	check(t, err)
	if len(list) != 1 || list[0].ID != "tt22248376" || list[0].Name != "Frieren: Beyond Journey's End" || list[0].Year != 2023 {
		t.Fatalf("watchlist = %+v", list)
	}
}

func TestActionsRefuseKidsProfiles(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	f.connectAniList(t)
	check(t, f.db.SetKids(f.profile.ID, true))
	ctx := context.Background()
	_, e1 := f.s.SetStatus(ctx, f.profile.ID, breakingBad, StatusPlanned)
	_, e2 := f.s.SetRating(ctx, f.profile.ID, breakingBad, 5)
	_, e3 := f.s.TitleStatus(ctx, f.profile.ID, breakingBad)
	_, e4 := f.s.Watchlist(ctx, f.profile.ID)
	for i, err := range []error{e1, e2, e3, e4} {
		if !errors.Is(err, ErrKidsProfile) || string(MarshalError(err)) != `{"code":"kids_profile"}` {
			t.Errorf("call %d: err = %v", i, err)
		}
	}
	if len(f.simkl.Writes("/sync/add-to-list"))+len(f.simkl.Writes("/sync/ratings"))+len(f.ani.saved) != 0 {
		t.Fatal("a kids profile wrote to a service")
	}
}

func TestChangesWaitInTheOutboxWhenOffline(t *testing.T) {
	f := setup(t)
	f.connectSimkl(t)
	f.connectAniList(t)
	f.simkl.Set(func(s *simkltest.Server) { s.Down = true })
	ctx := context.Background()

	got, err := f.s.SetStatus(ctx, f.profile.ID, breakingBad, StatusPlanned)
	check(t, err)
	if !got.Queued || got.Status != StatusPlanned {
		t.Fatalf("got %+v", got)
	}
	_, err = f.s.SetRating(ctx, f.profile.ID, breakingBad, 9)
	check(t, err)
	jobs, err := f.db.TrackingJobs(f.profile.ID)
	check(t, err)
	if len(jobs) != 2 || jobs[0].Service != ServiceSimkl {
		t.Fatalf("jobs = %+v", jobs)
	}
	// Still down when due: both stay. Then SIMKL is back, and they're sent in order.
	f.clock = f.clock.Add(retryFirst)
	f.s.sendJobs(ctx)
	if jobs, _ := f.db.TrackingJobs(f.profile.ID); len(jobs) != 2 {
		t.Fatalf("jobs after a failure = %+v", jobs)
	}
	f.simkl.Set(func(s *simkltest.Server) { s.Down = false })
	f.clock = f.clock.Add(2 * retryFirst)
	f.s.sendJobs(ctx)
	if jobs, _ := f.db.TrackingJobs(f.profile.ID); len(jobs) != 0 {
		t.Fatalf("jobs after sending = %+v", jobs)
	}
	if n, m := len(f.simkl.Writes("/sync/add-to-list")), len(f.simkl.Writes("/sync/ratings")); n != 1 || m != 1 {
		t.Fatalf("sent %d list moves and %d ratings", n, m)
	}
}
