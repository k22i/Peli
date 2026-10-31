package store

import (
	"encoding/json"
	"testing"
)

// An import adds marks and never removes one; it keeps a mark already here
// as it is, and progress newer than the imported watch (ADR-0042).
func TestImportWatched(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "Kevin", NuvioIndex: ptr(1)}))
	check(t, s.MarkWatched(p.ID, WatchedItem{ContentID: "tt1", ContentType: "movie", WatchedAt: 100}))
	must[Progress](t)(s.SaveProgress(p.ID, Progress{ContentID: "tt2", ContentType: "movie", VideoID: "tt2", Position: 10, Duration: 100, LastWatched: 500}))
	must[Progress](t)(s.SaveProgress(p.ID, Progress{ContentID: "tt3", ContentType: "movie", VideoID: "tt3", Position: 10, Duration: 100, LastWatched: 500}))
	pushes := len(must[[]Push](t)(s.Pending(p.ID)))

	added := must[int](t)(s.ImportWatched(p.ID, []WatchedItem{
		{ContentID: "tt1", ContentType: "movie", WatchedAt: 999},
		{ContentID: "tt2", ContentType: "movie", WatchedAt: 400}, // before the progress: a rewatch
		{ContentID: "tt3", ContentType: "movie", WatchedAt: 600},
		{ContentID: "tt4", ContentType: "series", Season: ptr(1), Episode: ptr(2), WatchedAt: 1},
	}))
	if added != 3 {
		t.Fatalf("added %d, want 3", added)
	}
	marks := must[[]WatchedItem](t)(s.Watched(p.ID))
	if len(marks) != 4 || marks[0].WatchedAt != 100 {
		t.Fatalf("marks = %+v", marks)
	}
	if got := must[[]Progress](t)(s.TitleProgress(p.ID, "tt2")); len(got) != 1 {
		t.Fatalf("tt2's newer progress went: %+v", got)
	}
	if got := must[[]Progress](t)(s.TitleProgress(p.ID, "tt3")); len(got) != 0 {
		t.Fatalf("tt3's older progress stayed: %+v", got)
	}
	// Three marks for Nuvio, and tt3's progress removed.
	if got := len(must[[]Push](t)(s.Pending(p.ID))); got != pushes+4 {
		t.Fatalf("%d pushes queued, want %d", got, pushes+4)
	}
}

func TestTrackingJobs(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "Kevin"}))
	check(t, s.UpdateTracking(p.ID, func(tr *Tracking) error {
		tr.Simkl = &SimklLink{User: "kevin"}
		return nil
	}))
	a := must[TrackingJob](t)(s.QueueTrackingJob(p.ID, TrackingJob{Service: "simkl", Payload: json.RawMessage(`{"a":1}`)}))
	must[TrackingJob](t)(s.QueueTrackingJob(p.ID, TrackingJob{Service: "anilist", Payload: json.RawMessage(`{}`)}))
	a.Attempts = 2
	check(t, s.SaveTrackingJob(p.ID, a))
	jobs := must[[]TrackingJob](t)(s.TrackingJobs(p.ID))
	if len(jobs) != 2 || jobs[0].Attempts != 2 || jobs[0].Seq >= jobs[1].Seq {
		t.Fatalf("jobs = %+v", jobs)
	}
	check(t, s.DropTrackingJobs(p.ID, "anilist"))
	if jobs := must[[]TrackingJob](t)(s.TrackingJobs(p.ID)); len(jobs) != 1 || jobs[0].Service != "simkl" {
		t.Fatalf("jobs = %+v", jobs)
	}
	if tracked := must[map[uint64]bool](t)(s.TrackedProfiles()); !tracked[p.ID] {
		t.Fatalf("tracked = %v", tracked)
	}

	check(t, s.SetTrackingTokenOwner(p.ID, true))
	check(t, s.SetTrackingTokenOwner(p.ID, true))
	if owners := must[[]uint64](t)(s.TrackingTokenOwners()); len(owners) != 1 || owners[0] != p.ID {
		t.Fatalf("owners = %v", owners)
	}
	check(t, s.SetTrackingTokenOwner(p.ID, false))
	if owners := must[[]uint64](t)(s.TrackingTokenOwners()); len(owners) != 0 {
		t.Fatalf("owners = %v", owners)
	}
}
