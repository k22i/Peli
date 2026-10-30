package watching

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/k22i/Sinag/internal/backend"
	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/player"
	"github.com/k22i/Sinag/internal/store"
	"github.com/k22i/Sinag/internal/syncer"
)

func ptr(n int) *int { return &n }

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// setup returns a store with a profile linked to Nuvio (so its writes are
// queued), and a reporter counting its pushes.
func setup(t *testing.T) (*store.Store, store.Profile, *Reporter, *atomic.Int32) {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "sinag.db"))
	check(t, err)
	t.Cleanup(func() { db.Close() })
	profile, err := db.CreateProfile(store.Profile{Name: "Kevin", NuvioIndex: ptr(1)})
	check(t, err)
	var pushes atomic.Int32
	rep := New(func() *store.Store { return db }, func(context.Context) error {
		pushes.Add(1)
		return nil
	})
	clock := time.UnixMilli(1_800_000_000_000)
	rep.now = func() time.Time { return clock }
	return db, profile, rep, &pushes
}

func episode(profile store.Profile) player.Watching {
	return player.Watching{
		ProfileID: profile.ID, ContentID: "tt0903747", ContentType: "series",
		VideoID: "tt0903747:2:4", Season: ptr(2), Episode: ptr(4), Title: "Down",
	}
}

func progress(t *testing.T, db *store.Store, profile store.Profile) []store.Progress {
	t.Helper()
	entries, err := db.TitleProgress(profile.ID, "tt0903747")
	check(t, err)
	return entries
}

func watched(t *testing.T, db *store.Store, profile store.Profile) []store.WatchedItem {
	t.Helper()
	items, err := db.TitleWatched(profile.ID, "tt0903747")
	check(t, err)
	return items
}

// Each report is the episode's progress, in ms, under Nuvio's key; only a
// pause, seek, end or stop asks for a push now.
func TestReportsBecomeProgress(t *testing.T) {
	db, profile, rep, pushes := setup(t)
	w := episode(profile)

	rep.Report(player.Report{Watching: w, Position: 600.25, Duration: 2820, Why: player.ReportPlaying})
	rep.wait()
	got := progress(t, db, profile)
	if len(got) != 1 {
		t.Fatalf("progress = %+v", got)
	}
	want := store.Progress{
		Key: "tt0903747_s2e4", ContentID: "tt0903747", ContentType: "series", VideoID: "tt0903747:2:4",
		Season: ptr(2), Episode: ptr(4), Position: 600_250, Duration: 2_820_000, LastWatched: 1_800_000_000_000,
	}
	if e := got[0]; e.Key != want.Key || e.VideoID != want.VideoID || *e.Season != 2 || *e.Episode != 4 ||
		e.Position != want.Position || e.Duration != want.Duration || e.LastWatched != want.LastWatched {
		t.Fatalf("progress = %+v, want %+v", e, want)
	}
	if n := pushes.Load(); n != 0 {
		t.Fatalf("a periodic report pushed %d times", n)
	}
	if resume, err := db.ContinueWatching(profile.ID); err != nil || len(resume) != 1 {
		t.Fatalf("ContinueWatching = %+v, %v", resume, err)
	}

	for _, why := range []string{player.ReportPaused, player.ReportSeeked, player.ReportStopped} {
		rep.Report(player.Report{Watching: w, Position: 700, Duration: 2820, Why: why})
		rep.wait()
	}
	if n := pushes.Load(); n != 3 {
		t.Fatalf("%d pushes for a pause, a seek and a stop", n)
	}
	if len(watched(t, db, profile)) != 0 {
		t.Fatal("marked watched at a quarter")
	}

	// A file whose length isn't known (still loading, or live) is nothing to
	// keep.
	rep.Report(player.Report{Watching: w, Position: 50, Duration: 0, Why: player.ReportStopped})
	rep.wait()
	if got := progress(t, db, profile); got[0].Position != 700_000 || pushes.Load() != 3 {
		t.Fatalf("progress = %+v after a report with no duration", got)
	}
}

// At 90 % the episode is marked watched, once, and leaves Continue Watching;
// the progress stays, as the server keeps it.
func TestMarkedWatchedAt90Percent(t *testing.T) {
	db, profile, rep, _ := setup(t)
	w := episode(profile)

	rep.Report(player.Report{Watching: w, Position: 2537, Duration: 2820, Why: player.ReportPlaying})
	if len(watched(t, db, profile)) != 0 {
		t.Fatal("marked watched just under 90 %")
	}
	rep.Report(player.Report{Watching: w, Position: 2538, Duration: 2820, Why: player.ReportPlaying})
	marks := watched(t, db, profile)
	if len(marks) != 1 || *marks[0].Season != 2 || *marks[0].Episode != 4 || marks[0].Title != "Down" ||
		marks[0].ContentType != "series" || marks[0].WatchedAt != 1_800_000_000_000 {
		t.Fatalf("watched = %+v", marks)
	}
	if resume, _ := db.ContinueWatching(profile.ID); len(resume) != 0 {
		t.Fatalf("still in Continue Watching: %+v", resume)
	}
	if got := progress(t, db, profile); len(got) != 1 || got[0].Position != 2_538_000 {
		t.Fatalf("progress = %+v", got)
	}

	// Playing on to the end queues no second mark.
	before, err := db.Pending(profile.ID)
	check(t, err)
	rep.Report(player.Report{Watching: w, Position: 2820, Duration: 2820, Why: player.ReportEnded})
	rep.wait()
	after, err := db.Pending(profile.ID)
	check(t, err)
	if watchedPushes(after) != watchedPushes(before) || watchedPushes(after) != 1 {
		t.Fatalf("watched pushes queued: %d before the end, %d after", watchedPushes(before), watchedPushes(after))
	}
}

func watchedPushes(pending []store.Push) int {
	n := 0
	for _, push := range pending {
		if push.Surface == store.SurfaceWatched {
			n++
		}
	}
	return n
}

// An item marked already (watched before, or marked by hand) isn't marked
// again, and the other episodes' marks don't count for it.
func TestAlreadyWatchedIsNotMarkedAgain(t *testing.T) {
	db, profile, rep, _ := setup(t)
	w := episode(profile)
	check(t, db.MarkWatched(profile.ID, store.WatchedItem{ContentID: w.ContentID, ContentType: "series", Season: ptr(2), Episode: ptr(3), WatchedAt: 1}))
	check(t, db.MarkWatched(profile.ID, store.WatchedItem{ContentID: w.ContentID, ContentType: "series", Season: ptr(2), Episode: ptr(4), WatchedAt: 2}))
	before, err := db.Pending(profile.ID)
	check(t, err)

	rep.Report(player.Report{Watching: w, Position: 2700, Duration: 2820, Why: player.ReportPlaying})
	after, err := db.Pending(profile.ID)
	check(t, err)
	if watchedPushes(after) != watchedPushes(before) {
		t.Fatalf("queued another watched push: %+v", after)
	}
	for _, mark := range watched(t, db, profile) {
		if *mark.Episode == 4 && mark.WatchedAt != 2 {
			t.Fatalf("the mark changed: %+v", mark)
		}
	}
}

// Under a minute, Nuvio's server marks nothing, and nor does Sinag.
func TestShortFilesAreNotMarked(t *testing.T) {
	db, profile, rep, _ := setup(t)
	film := player.Watching{ProfileID: profile.ID, ContentID: "tt0903747", ContentType: "movie", VideoID: "tt0903747"}
	rep.Report(player.Report{Watching: film, Position: 59, Duration: 59, Why: player.ReportEnded})
	rep.wait()
	if len(watched(t, db, profile)) != 0 {
		t.Fatal("marked a 59 s file watched")
	}
	if got := progress(t, db, profile); len(got) != 1 || got[0].Key != "tt0903747" || got[0].Season != nil {
		t.Fatalf("progress = %+v", got)
	}
}

// A burst of seeks while a push is out becomes one more push, not one each.
func TestPushesCoalesce(t *testing.T) {
	db, profile, _, _ := setup(t)
	release := make(chan struct{})
	var pushes atomic.Int32
	rep := New(func() *store.Store { return db }, func(context.Context) error {
		pushes.Add(1)
		<-release
		return nil
	})
	w := episode(profile)
	for i := range 5 {
		rep.Report(player.Report{Watching: w, Position: float64(100 + i*20), Duration: 2820, Why: player.ReportSeeked})
	}
	close(release)
	rep.wait()
	if n := pushes.Load(); n != 2 {
		t.Fatalf("%d pushes for five seeks, want the one out and one more", n)
	}
	if got := progress(t, db, profile); got[0].Position != 180_000 {
		t.Fatalf("progress = %+v, want the last seek", got)
	}
}

// A guest plays and resumes with no request to Nuvio (#23's check for #64):
// the reports, the mark at 90 % and the pushes they ask for stay local.
func TestGuestReportsMakeNoNuvioRequests(t *testing.T) {
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		t.Errorf("guest sent %s %s to Nuvio", r.Method, r.URL)
		w.WriteHeader(http.StatusTeapot)
	}))
	defer server.Close()

	db, err := store.Open(filepath.Join(t.TempDir(), "sinag.db"))
	check(t, err)
	defer db.Close()
	guest, err := db.SwitchToGuest()
	check(t, err)
	open := func() *store.Store { return db }
	pusher := syncer.NewPusher(open, backend.Nuvio{Client: nuvio.New(server.URL, "1.2.3")})
	rep := New(open, pusher.FlushProgress)

	film := player.Watching{ProfileID: guest.ID, ContentID: "tt1160419", ContentType: "movie", VideoID: "tt1160419"}
	for _, r := range []player.Report{
		{Watching: film, Position: 600, Duration: 9360, Why: player.ReportPlaying},
		{Watching: film, Position: 610, Duration: 9360, Why: player.ReportPaused},
		{Watching: film, Position: 1200, Duration: 9360, Why: player.ReportStopped},
	} {
		rep.Report(r)
		rep.wait()
	}
	if resume, err := db.ContinueWatching(guest.ID); err != nil || len(resume) != 1 || resume[0].Position != 1_200_000 {
		t.Fatalf("ContinueWatching = %+v, %v", resume, err)
	}
	rep.Report(player.Report{Watching: film, Position: 9000, Duration: 9360, Why: player.ReportEnded})
	rep.wait()
	if marks, err := db.Watched(guest.ID); err != nil || len(marks) != 1 {
		t.Fatalf("Watched = %+v, %v", marks, err)
	}
	check(t, pusher.Flush(t.Context()))
	if n := requests.Load(); n != 0 {
		t.Fatalf("%d requests to Nuvio", n)
	}
}
