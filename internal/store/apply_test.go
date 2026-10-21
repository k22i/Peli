package store

import (
	"encoding/json"
	"errors"
	"testing"
)

func change(t testing.TB, surface Surface, op Op, item any) Change {
	t.Helper()
	data, err := json.Marshal(item)
	if err != nil {
		t.Fatal(err)
	}
	return Change{Surface: surface, Op: op, Item: data}
}

// Applying a feed writes to the store and queues nothing, even for a linked
// profile, and applying it again changes nothing (#28).
func TestApplyChanges(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	watched := WatchedItem{ContentID: "tt0388629", ContentType: "series", Season: ptr(2), Episode: ptr(200), WatchedAt: 9}
	feed := []Change{
		change(t, SurfaceLibrary, OpUpsert, dune),
		change(t, SurfaceProgress, OpUpsert, episode),
		change(t, SurfaceWatched, OpUpsert, watched),
		change(t, SurfaceAddons, OpUpsert, []Addon{cinemeta}),
	}

	equal(t, must[int](t)(s.ApplyChanges(linked.ID, feed)), 4)
	equal(t, must[[]LibraryItem](t)(s.Library(linked.ID)), []LibraryItem{dune})
	got := must[[]Progress](t)(s.TitleProgress(linked.ID, episode.ContentID))
	want := episode
	want.Key = "tt11280740_s1e2"
	equal(t, got, []Progress{want})
	equal(t, must[[]WatchedItem](t)(s.Watched(linked.ID)), []WatchedItem{watched})
	equal(t, must[[]Addon](t)(s.Addons(linked.ID)), []Addon{cinemeta})
	equal(t, must[[]Push](t)(s.Pending(linked.ID)), []Push{})

	// The echo of our own writes, or a page fetched twice: nothing to do.
	equal(t, must[int](t)(s.ApplyChanges(linked.ID, feed)), 0)

	// A delete event carries the row as it was and is applied by key.
	equal(t, must[int](t)(s.ApplyChanges(linked.ID, []Change{
		change(t, SurfaceLibrary, OpDelete, dune),
		change(t, SurfaceWatched, OpDelete, watched),
		change(t, SurfaceLibrary, OpDelete, severance), // never here
	})), 2)
	equal(t, must[[]LibraryItem](t)(s.Library(linked.ID)), []LibraryItem{})
	equal(t, must[[]WatchedItem](t)(s.Watched(linked.ID)), []WatchedItem{})
	equal(t, must[[]Push](t)(s.Pending(linked.ID)), []Push{})
}

// A change made here and not yet pushed wins over the backend's copy, so the
// echo of an earlier write can't undo it.
func TestApplyChangesSkipsQueuedItems(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	check(t, s.SaveLibraryItem(linked.ID, dune))
	check(t, s.SetAddons(linked.ID, []Addon{cinemeta}))
	check(t, s.MarkWatched(linked.ID, WatchedItem{ContentID: "tt1", ContentType: "movie", WatchedAt: 1}))

	older := dune
	older.Name = "Dune (old)"
	equal(t, must[int](t)(s.ApplyChanges(linked.ID, []Change{
		change(t, SurfaceLibrary, OpUpsert, older),
		change(t, SurfaceLibrary, OpDelete, dune),
		change(t, SurfaceAddons, OpUpsert, []Addon{}),
		change(t, SurfaceWatched, OpDelete, WatchedItem{ContentID: "tt1", ContentType: "movie"}),
		change(t, SurfaceLibrary, OpUpsert, severance), // nothing queued for it
	})), 1)
	equal(t, must[[]LibraryItem](t)(s.Library(linked.ID)), []LibraryItem{severance, dune})
	equal(t, must[[]Addon](t)(s.Addons(linked.ID)), []Addon{cinemeta})
	equal(t, len(must[[]WatchedItem](t)(s.Watched(linked.ID))), 1)

	// Once the push is acked the backend's copy applies again.
	for _, push := range must[[]Push](t)(s.Pending(linked.ID)) {
		check(t, s.AckPush(linked.ID, push))
	}
	equal(t, must[int](t)(s.ApplyChanges(linked.ID, []Change{change(t, SurfaceLibrary, OpUpsert, older)})), 1)
}

func TestApplyChangesInvalid(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P", NuvioIndex: ptr(1)}))
	for name, c := range map[string]Change{
		"no content ID":     change(t, SurfaceLibrary, OpUpsert, LibraryItem{ContentType: "movie"}),
		"unknown surface":   change(t, "plugins", OpUpsert, dune),
		"unknown operation": change(t, SurfaceLibrary, "merge", dune),
		"not JSON":          {Surface: SurfaceWatched, Op: OpUpsert, Item: json.RawMessage(`[`)},
	} {
		// A bad change fails the whole batch: none of it is written.
		if _, err := s.ApplyChanges(p.ID, []Change{change(t, SurfaceLibrary, OpUpsert, dune), c}); !errors.Is(err, ErrInvalidItem) {
			t.Errorf("%s: err = %v, want ErrInvalidItem", name, err)
		}
	}
	equal(t, must[[]LibraryItem](t)(s.Library(p.ID)), []LibraryItem{})
}
