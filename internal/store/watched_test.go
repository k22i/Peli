package store

import (
	"errors"
	"strings"
	"testing"
)

// SetWatched marks a season in one go, skips what's already marked, clears
// progress either way, and queues a push per change (#45).
func TestSetWatched(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	id := linked.ID
	episode := func(n int) WatchedItem {
		return WatchedItem{ContentID: "tt9", ContentType: "series", Season: ptr(1), Episode: ptr(n), WatchedAt: int64(n)}
	}

	check(t, s.MarkWatched(id, WatchedItem{ContentID: "tt9", ContentType: "series", Season: ptr(1), Episode: ptr(1), WatchedAt: 99}))
	must[Progress](t)(s.SaveProgress(id, Progress{ContentID: "tt9", ContentType: "series", Season: ptr(1), Episode: ptr(2), Position: 10, Duration: 100}))
	must[Progress](t)(s.SaveProgress(id, Progress{ContentID: "tt9", ContentType: "series", Season: ptr(2), Episode: ptr(1), Position: 10, Duration: 100}))
	ackAll(t, s, id)

	season := []WatchedItem{episode(1), episode(2), episode(3)}
	check(t, s.SetWatched(id, season, true))
	first := episode(1)
	first.WatchedAt = 99 // kept, not re-marked
	equal(t, must[[]WatchedItem](t)(s.TitleWatched(id, "tt9")), []WatchedItem{first, episode(2), episode(3)})
	// Episode 2's progress is cleared; season 2's isn't touched.
	equal(t, len(must[[]Progress](t)(s.TitleProgress(id, "tt9"))), 1)
	equal(t, pendingOps(t, s, id), []string{
		"watched upsert tt9|1|2", "progress delete tt9_s1e2", "watched upsert tt9|1|3",
	})

	ackAll(t, s, id)
	check(t, s.SetWatched(id, season[:2], false))
	equal(t, must[[]WatchedItem](t)(s.TitleWatched(id, "tt9")), []WatchedItem{episode(3)})
	equal(t, pendingOps(t, s, id), []string{"watched delete tt9|1|1", "watched delete tt9|1|2"})

	if err := s.SetWatched(id, []WatchedItem{{ContentID: "tt9"}}, true); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("missing type: err = %v", err)
	}
	// Unmarking needs only the ID.
	check(t, s.SetWatched(id, []WatchedItem{{ContentID: "tt9", Season: ptr(1), Episode: ptr(3)}}, false))
	equal(t, must[[]WatchedItem](t)(s.TitleWatched(id, "tt9")), []WatchedItem{})
}

func ackAll(t *testing.T, s *Store, id uint64) {
	t.Helper()
	for _, p := range must[[]Push](t)(s.Pending(id)) {
		check(t, s.AckPush(id, p))
	}
}

func pendingOps(t *testing.T, s *Store, id uint64) []string {
	t.Helper()
	ops := []string{}
	for _, p := range must[[]Push](t)(s.Pending(id)) {
		ops = append(ops, string(p.Surface)+" "+string(p.Op)+" "+strings.ReplaceAll(p.Key, "\x00", "|"))
	}
	return ops
}
