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

// Progress is the one surface with a conflict rule: the latest lastWatched
// wins, in either direction (#29).
func TestApplyChangesProgressLatestWins(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P", NuvioIndex: ptr(1)}))
	at := func(position, lastWatched int64) Progress {
		e := episode
		e.Position, e.LastWatched = position, lastWatched
		return e
	}
	position := func() Progress {
		return must[[]Progress](t)(s.TitleProgress(p.ID, episode.ContentID))[0]
	}

	equal(t, must[int](t)(s.ApplyChanges(p.ID, []Change{change(t, SurfaceProgress, OpUpsert, at(100, 1000))})), 1)
	// Older than ours (a throttled push the backend dropped, say): skipped.
	equal(t, must[int](t)(s.ApplyChanges(p.ID, []Change{change(t, SurfaceProgress, OpUpsert, at(50, 500))})), 0)
	equal(t, position().Position, int64(100))
	// Newer, from another device: applied.
	equal(t, must[int](t)(s.ApplyChanges(p.ID, []Change{change(t, SurfaceProgress, OpUpsert, at(300, 2000))})), 1)
	equal(t, position().Position, int64(300))
	// The same time, a different position: the backend's copy.
	equal(t, must[int](t)(s.ApplyChanges(p.ID, []Change{change(t, SurfaceProgress, OpUpsert, at(310, 2000))})), 1)
	equal(t, position().Position, int64(310))

	// A delete of a row older than ours is not about ours: watched again since.
	equal(t, must[int](t)(s.ApplyChanges(p.ID, []Change{change(t, SurfaceProgress, OpDelete, at(100, 1000))})), 0)
	equal(t, len(must[[]Progress](t)(s.TitleProgress(p.ID, episode.ContentID))), 1)
	equal(t, must[int](t)(s.ApplyChanges(p.ID, []Change{change(t, SurfaceProgress, OpDelete, at(310, 2000))})), 1)
	equal(t, len(must[[]Progress](t)(s.TitleProgress(p.ID, episode.ContentID))), 0)
}

// The backend makes a watched item itself when progress passes 90 %, so a
// pulled one settles a queued upsert of it: the push would only repeat it.
// A queued delete is the user's later decision and stays.
func TestApplyChangesWatchedUpsertSettlesQueuedUpsert(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	item := WatchedItem{ContentID: "tt0388629", ContentType: "series", Season: ptr(2), Episode: ptr(200), WatchedAt: 9}
	pulled := change(t, SurfaceWatched, OpUpsert, WatchedItem{ContentID: item.ContentID, ContentType: "series", Season: item.Season, Episode: item.Episode, WatchedAt: 7})

	check(t, s.MarkWatched(linked.ID, item))
	equal(t, must[int](t)(s.ApplyChanges(linked.ID, []Change{pulled})), 1)
	equal(t, must[[]Push](t)(s.Pending(linked.ID)), []Push{})
	equal(t, must[[]WatchedItem](t)(s.Watched(linked.ID))[0].WatchedAt, int64(7))

	check(t, s.UnmarkWatched(linked.ID, item.ContentID, item.Season, item.Episode))
	check(t, s.MarkWatched(linked.ID, item))
	check(t, s.UnmarkWatched(linked.ID, item.ContentID, item.Season, item.Episode))
	equal(t, must[int](t)(s.ApplyChanges(linked.ID, []Change{pulled})), 0)
	equal(t, len(must[[]Push](t)(s.Pending(linked.ID))), 1)
	equal(t, must[[]WatchedItem](t)(s.Watched(linked.ID)), []WatchedItem{})
}

// The push loop (#30) wakes after a write that queued a push, once it has
// committed, and not for one that didn't.
func TestOnQueued(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	guest := must[Profile](t)(s.CreateProfile(Profile{Name: "Guest"}))
	var woken []uint64
	s.OnQueued(func(id uint64) {
		// The change is readable by now.
		if len(must[[]Push](t)(s.Pending(id))) == 0 {
			t.Error("woken before the push was committed")
		}
		woken = append(woken, id)
	})

	check(t, s.SaveLibraryItem(linked.ID, dune))
	_, err := s.SaveProgress(linked.ID, episode)
	check(t, err)
	check(t, s.SaveLibraryItem(guest.ID, dune))                                                  // local-only: queues nothing
	_, err = s.ApplyChanges(linked.ID, []Change{change(t, SurfaceLibrary, OpUpsert, severance)}) // from the backend
	check(t, err)
	check(t, s.SetCursor(linked.ID, SurfaceLibrary, 5))
	equal(t, woken, []uint64{linked.ID, linked.ID})

	// Acking a push isn't a new one.
	for _, push := range must[[]Push](t)(s.Pending(linked.ID)) {
		check(t, s.AckPush(linked.ID, push))
	}
	equal(t, len(woken), 2)

	s.OnQueued(nil)
	check(t, s.RemoveLibraryItem(linked.ID, dune.ContentID, dune.ContentType))
	equal(t, len(woken), 2)
}
