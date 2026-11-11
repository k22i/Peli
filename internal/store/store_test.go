package store

import (
	"encoding/json"
	"errors"
	"math"
	"path/filepath"
	"reflect"
	"testing"
)

func ptr[T any](v T) *T { return &v }

func openTemp(t testing.TB) (*Store, string) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "Sinag", "sinag.db")
	s, err := Open(path)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { s.Close() })
	return s, path
}

func must[T any](t testing.TB) func(v T, err error) T {
	return func(v T, err error) T {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
		return v
	}
}

func check(t testing.TB, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func equal[T any](t testing.TB, got, want T) {
	t.Helper()
	if !reflect.DeepEqual(got, want) {
		g, _ := json.Marshal(got)
		w, _ := json.Marshal(want)
		t.Fatalf("got  %s\nwant %s", g, w)
	}
}

var (
	dune = LibraryItem{
		ContentID: "tt1160419", ContentType: "movie", Name: "Dune", Poster: "https://img/dune.jpg",
		PosterShape: "POSTER", IMDBRating: ptr(8.0), Genres: []string{"Sci-Fi"}, AddedAt: 2000,
	}
	severance = LibraryItem{ContentID: "tt11280740", ContentType: "series", Name: "Severance", AddedAt: 3000}
	episode   = Progress{
		ContentID: "tt11280740", ContentType: "series", VideoID: "tt11280740:1:2",
		Season: ptr(1), Episode: ptr(2), Position: 600_000, Duration: 3_000_000, LastWatched: 5000,
	}
	cinemeta = Addon{URL: "https://v3-cinemeta.strem.io/manifest.json", Name: "Cinemeta", Enabled: true}
)

// The acceptance criterion: library and progress survive a restart.
func TestReopenKeepsData(t *testing.T) {
	s, path := openTemp(t)
	guest := must[Profile](t)(s.CreateProfile(Profile{Name: "Guest"}))
	check(t, s.SaveLibraryItem(guest.ID, dune))
	check(t, s.SaveLibraryItem(guest.ID, severance))
	saved := must[Progress](t)(s.SaveProgress(guest.ID, episode))
	check(t, s.MarkWatched(guest.ID, WatchedItem{ContentID: "tt1160419", ContentType: "movie", WatchedAt: 4000}))
	check(t, s.SetAddons(guest.ID, []Addon{cinemeta}))
	check(t, s.CacheSet("query-cache", []byte(`{"queries":[]}`)))
	check(t, s.Close())

	s, err := Open(path)
	check(t, err)
	defer s.Close()

	equal(t, must[[]Profile](t)(s.Profiles()), []Profile{guest})
	equal(t, must[[]LibraryItem](t)(s.Library(guest.ID)), []LibraryItem{severance, dune})
	equal(t, must[[]Progress](t)(s.ContinueWatching(guest.ID)), []Progress{saved})
	equal(t, must[[]WatchedItem](t)(s.Watched(guest.ID)),
		[]WatchedItem{{ContentID: "tt1160419", ContentType: "movie", WatchedAt: 4000}})
	equal(t, must[[]Addon](t)(s.Addons(guest.ID)), []Addon{cinemeta})
	value, ok, err := s.CacheGet("query-cache")
	check(t, err)
	if !ok || string(value) != `{"queries":[]}` {
		t.Fatalf("cache = %q, %v", value, ok)
	}
}

func TestClearCache(t *testing.T) {
	s, _ := openTemp(t)
	check(t, s.CacheSet("a", []byte("1")))
	check(t, s.CacheSet("b", []byte("2")))
	check(t, s.ClearCache())
	for _, key := range []string{"a", "b"} {
		if _, ok, err := s.CacheGet(key); ok || err != nil {
			t.Fatalf("CacheGet(%q) = %v, %v after clearing", key, ok, err)
		}
	}
	check(t, s.CacheSet("a", []byte("3")))
}

func TestProfilesAreIsolated(t *testing.T) {
	s, _ := openTemp(t)
	a := must[Profile](t)(s.CreateProfile(Profile{Name: "A"}))
	b := must[Profile](t)(s.CreateProfile(Profile{Name: "B"}))
	check(t, s.SaveLibraryItem(a.ID, dune))
	must[Progress](t)(s.SaveProgress(a.ID, episode))
	check(t, s.MarkWatched(a.ID, WatchedItem{ContentID: "tt1160419", ContentType: "movie"}))
	check(t, s.SetAddons(a.ID, []Addon{cinemeta}))

	equal(t, must[[]LibraryItem](t)(s.Library(b.ID)), []LibraryItem{})
	equal(t, must[[]Progress](t)(s.ContinueWatching(b.ID)), []Progress{})
	equal(t, must[[]WatchedItem](t)(s.Watched(b.ID)), []WatchedItem{})
	equal(t, must[[]Addon](t)(s.Addons(b.ID)), []Addon{})

	// Deleting a profile deletes its data and nothing else.
	check(t, s.SaveLibraryItem(b.ID, severance))
	check(t, s.DeleteProfile(a.ID))
	equal(t, must[[]Profile](t)(s.Profiles()), []Profile{b})
	equal(t, must[[]LibraryItem](t)(s.Library(b.ID)), []LibraryItem{severance})
	if _, err := s.Library(a.ID); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("Library(deleted) err = %v, want ErrProfileNotFound", err)
	}
	if err := s.SaveLibraryItem(a.ID, dune); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("SaveLibraryItem(deleted) err = %v, want ErrProfileNotFound", err)
	}
	if err := s.DeleteProfile(a.ID); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("DeleteProfile(deleted) err = %v, want ErrProfileNotFound", err)
	}

	// IDs are not reused, so stale references can't reach a new profile.
	c := must[Profile](t)(s.CreateProfile(Profile{Name: "C"}))
	if c.ID == a.ID {
		t.Fatalf("new profile reused deleted ID %d", a.ID)
	}
}

func TestProfileValidation(t *testing.T) {
	s, _ := openTemp(t)
	if _, err := s.CreateProfile(Profile{Name: " "}); !errors.Is(err, ErrInvalidProfile) {
		t.Fatalf("empty name: err = %v", err)
	}
	for _, index := range []int{0, 7} {
		if _, err := s.CreateProfile(Profile{Name: "X", NuvioIndex: ptr(index)}); !errors.Is(err, ErrInvalidProfile) {
			t.Fatalf("Nuvio index %d: err = %v", index, err)
		}
	}
	one := must[Profile](t)(s.CreateProfile(Profile{Name: "One", NuvioIndex: ptr(1)}))
	if _, err := s.CreateProfile(Profile{Name: "Two", NuvioIndex: ptr(1)}); !errors.Is(err, ErrNuvioIndexUsed) {
		t.Fatalf("duplicate Nuvio index: err = %v", err)
	}
	// A profile keeps its own index when updated.
	one.Name = "Uno"
	check(t, s.UpdateProfile(one))
	equal(t, must[Profile](t)(s.Profile(one.ID)), one)
	if err := s.UpdateProfile(Profile{ID: 99, Name: "Ghost"}); !errors.Is(err, ErrProfileNotFound) {
		t.Fatalf("update missing: err = %v", err)
	}
}

func TestContinueWatching(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	save := func(entry Progress) { must[Progress](t)(s.SaveProgress(p.ID, entry)) }

	save(Progress{ContentID: "tt1", ContentType: "movie", Position: 10, Duration: 100, LastWatched: 1})
	// Finished (≥ 90 %) and not-started entries are left out.
	save(Progress{ContentID: "tt2", ContentType: "movie", Position: 90, Duration: 100, LastWatched: 2})
	save(Progress{ContentID: "tt3", ContentType: "movie", Position: 0, Duration: 100, LastWatched: 3})
	// Only a series' latest episode counts, even when it's finished.
	save(Progress{ContentID: "tt4", ContentType: "series", Season: ptr(1), Episode: ptr(1), Position: 50, Duration: 100, LastWatched: 4})
	save(Progress{ContentID: "tt4", ContentType: "series", Season: ptr(1), Episode: ptr(2), Position: 20, Duration: 100, LastWatched: 6})
	save(Progress{ContentID: "tt5", ContentType: "series", Season: ptr(2), Episode: ptr(1), Position: 30, Duration: 100, LastWatched: 5})
	save(Progress{ContentID: "tt5", ContentType: "series", Season: ptr(2), Episode: ptr(2), Position: 95, Duration: 100, LastWatched: 7})

	var got []string
	for _, entry := range must[[]Progress](t)(s.ContinueWatching(p.ID)) {
		got = append(got, entry.Key)
	}
	equal(t, got, []string{"tt4_s1e2", "tt1"})
}

func TestClearContinueWatching(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P", NuvioIndex: ptr(1)}))
	save := func(entry Progress) { must[Progress](t)(s.SaveProgress(p.ID, entry)) }
	keys := func() []string {
		var got []string
		for _, entry := range must[[]Progress](t)(s.ContinueWatching(p.ID)) {
			got = append(got, entry.Key)
		}
		return got
	}

	// A show with two unfinished episodes and a finished one, a longer ID
	// that shares its prefix, and a film.
	save(Progress{ContentID: "tt1", ContentType: "series", Season: ptr(1), Episode: ptr(1), Position: 50, Duration: 100, LastWatched: 1})
	save(Progress{ContentID: "tt1", ContentType: "series", Season: ptr(1), Episode: ptr(2), Position: 20, Duration: 100, LastWatched: 2})
	save(Progress{ContentID: "tt1", ContentType: "series", Season: ptr(1), Episode: ptr(3), Position: 95, Duration: 100, LastWatched: 0})
	save(Progress{ContentID: "tt12", ContentType: "movie", Position: 10, Duration: 100, LastWatched: 3})
	save(Progress{ContentID: "tt9", ContentType: "movie", Position: 10, Duration: 100, LastWatched: 4})
	equal(t, keys(), []string{"tt9", "tt12", "tt1_s1e2"})

	// Both unfinished episodes go, not just the latest, or the older one
	// would take its place in the row. The finished one stays.
	removed := must[int](t)(s.ClearContinueWatching(p.ID, "tt1"))
	equal(t, removed, 2)
	equal(t, keys(), []string{"tt9", "tt12"})
	equal(t, len(must[[]Progress](t)(s.TitleProgress(p.ID, "tt1"))), 1)
	if len(must[[]WatchedItem](t)(s.TitleWatched(p.ID, "tt1"))) != 0 {
		t.Fatal("clearing marked the title watched")
	}

	// A delete per removed entry reaches Nuvio, in place of its upsert.
	var deletes []string
	for _, push := range must[[]Push](t)(s.Pending(p.ID)) {
		if push.Surface == SurfaceProgress && push.Op == OpDelete {
			deletes = append(deletes, push.Key)
		}
	}
	equal(t, deletes, []string{"tt1_s1e1", "tt1_s1e2"})

	// Nothing to clear is not an error, and playing it again brings it back.
	equal(t, must[int](t)(s.ClearContinueWatching(p.ID, "tt1")), 0)
	save(Progress{ContentID: "tt1", ContentType: "series", Season: ptr(1), Episode: ptr(2), Position: 5, Duration: 100, LastWatched: 9})
	equal(t, keys(), []string{"tt1_s1e2", "tt9", "tt12"})
}

func TestLastWatched(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	other := must[Profile](t)(s.CreateProfile(Profile{Name: "Q"}))
	save := func(entry Progress) { must[Progress](t)(s.SaveProgress(p.ID, entry)) }

	// A series' latest episode counts, finished or not.
	save(Progress{ContentID: "tt1", ContentType: "series", Season: ptr(1), Episode: ptr(1), Position: 95, Duration: 100, LastWatched: 3})
	save(Progress{ContentID: "tt1", ContentType: "series", Season: ptr(1), Episode: ptr(2), Position: 10, Duration: 100, LastWatched: 2})
	// A watched mark later than the progress wins, and an earlier one doesn't.
	save(Progress{ContentID: "tt2", ContentType: "movie", Position: 10, Duration: 100, LastWatched: 4})
	if err := s.MarkWatched(p.ID, WatchedItem{ContentID: "tt2", ContentType: "movie", WatchedAt: 1}); err != nil {
		t.Fatal(err)
	}
	if err := s.MarkWatched(p.ID, WatchedItem{ContentID: "tt3", ContentType: "series", Season: ptr(1), Episode: ptr(1), WatchedAt: 7}); err != nil {
		t.Fatal(err)
	}
	// Another profile's history stays its own.
	must[Progress](t)(s.SaveProgress(other.ID, Progress{ContentID: "tt4", ContentType: "movie", Position: 1, LastWatched: 9}))

	equal(t, must[map[string]int64](t)(s.LastWatched(p.ID)), map[string]int64{"tt1": 3, "tt2": 4, "tt3": 7})
}

func TestProgressKeys(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))

	movie := must[Progress](t)(s.SaveProgress(p.ID, Progress{ContentID: "tt12", ContentType: "movie", Position: 1}))
	if movie.Key != "tt12" || movie.VideoID != "tt12" {
		t.Fatalf("movie key, video = %q, %q", movie.Key, movie.VideoID)
	}
	ep := must[Progress](t)(s.SaveProgress(p.ID, episode))
	if ep.Key != "tt11280740_s1e2" {
		t.Fatalf("episode key = %q", ep.Key)
	}
	// Saving again replaces the entry instead of adding one.
	ep.Position = 900_000
	ep = must[Progress](t)(s.SaveProgress(p.ID, ep))
	// "tt12" is a prefix of "tt123": a title's progress must not include it.
	must[Progress](t)(s.SaveProgress(p.ID, Progress{ContentID: "tt123", ContentType: "movie", Position: 1}))

	equal(t, must[[]Progress](t)(s.TitleProgress(p.ID, "tt11280740")), []Progress{ep})
	equal(t, must[[]Progress](t)(s.TitleProgress(p.ID, "tt12")), []Progress{movie})

	check(t, s.RemoveProgress(p.ID, "tt12"))
	equal(t, must[[]Progress](t)(s.TitleProgress(p.ID, "tt12")), []Progress{})
	check(t, s.RemoveProgress(p.ID, "tt12")) // already gone
	if _, err := s.SaveProgress(p.ID, Progress{ContentID: "tt1"}); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("missing type: err = %v", err)
	}
}

func TestWatchedOrder(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	mark := func(season, episode *int) WatchedItem {
		item := WatchedItem{ContentID: "tt9", ContentType: "series", Season: season, Episode: episode}
		check(t, s.MarkWatched(p.ID, item))
		return item
	}
	s10e1 := mark(ptr(10), ptr(1))
	s2e10 := mark(ptr(2), ptr(10))
	s2e2 := mark(ptr(2), ptr(2))
	specials := mark(ptr(0), ptr(1))
	whole := mark(nil, nil)
	check(t, s.MarkWatched(p.ID, WatchedItem{ContentID: "tt90", ContentType: "movie"}))

	// Numeric order, specials (season 0) after the series-level mark.
	equal(t, must[[]WatchedItem](t)(s.TitleWatched(p.ID, "tt9")),
		[]WatchedItem{whole, specials, s2e2, s2e10, s10e1})

	check(t, s.UnmarkWatched(p.ID, "tt9", ptr(2), ptr(10)))
	check(t, s.UnmarkWatched(p.ID, "tt9", nil, nil))
	equal(t, must[[]WatchedItem](t)(s.TitleWatched(p.ID, "tt9")), []WatchedItem{specials, s2e2, s10e1})
}

func TestAddons(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	torrentio := Addon{URL: "https://torrentio.strem.fun/manifest.json", Name: "Torrentio"}

	check(t, s.SetAddons(p.ID, []Addon{cinemeta, torrentio}))
	check(t, s.SetAddons(p.ID, []Addon{torrentio, cinemeta}))
	equal(t, must[[]Addon](t)(s.Addons(p.ID)), []Addon{torrentio, cinemeta})
	check(t, s.SetAddons(p.ID, nil))
	equal(t, must[[]Addon](t)(s.Addons(p.ID)), []Addon{})

	if err := s.SetAddons(p.ID, []Addon{cinemeta, cinemeta}); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("duplicate URL: err = %v", err)
	}
	if err := s.SetAddons(p.ID, []Addon{{Name: "No URL"}}); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("missing URL: err = %v", err)
	}
}

func TestCursors(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P", NuvioIndex: ptr(1)}))

	if _, ok, err := s.Cursor(p.ID, SurfaceLibrary); err != nil || ok {
		t.Fatalf("unset cursor: ok = %v, err = %v", ok, err)
	}
	// Live event IDs are a global sequence in the hundreds of millions.
	for _, cursor := range []int64{0, 242_369_012, math.MaxInt64} {
		check(t, s.SetCursor(p.ID, SurfaceWatched, cursor))
		got, ok, err := s.Cursor(p.ID, SurfaceWatched)
		if err != nil || !ok || got != cursor {
			t.Fatalf("Cursor = %d, %v, %v; want %d", got, ok, err, cursor)
		}
	}
	if _, ok, _ := s.Cursor(p.ID, SurfaceProgress); ok {
		t.Fatal("cursors leak between surfaces")
	}
}

func TestOutbox(t *testing.T) {
	s, _ := openTemp(t)
	guest := must[Profile](t)(s.CreateProfile(Profile{Name: "Guest"}))
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))

	for _, p := range []Profile{guest, linked} {
		check(t, s.SaveLibraryItem(p.ID, dune))
		must[Progress](t)(s.SaveProgress(p.ID, episode))
		check(t, s.MarkWatched(p.ID, WatchedItem{ContentID: "tt1160419", ContentType: "movie"}))
		check(t, s.SetAddons(p.ID, []Addon{cinemeta}))
	}

	// Guests have nothing to push.
	equal(t, must[[]Push](t)(s.Pending(guest.ID)), []Push{})

	surfaces := func() (got []string) {
		for _, push := range must[[]Push](t)(s.Pending(linked.ID)) {
			got = append(got, string(push.Surface)+" "+string(push.Op))
		}
		return got
	}
	equal(t, surfaces(), []string{"library upsert", "progress upsert", "watched upsert", "addons upsert"})

	// A newer change to the same item replaces its push and moves it last.
	moved := episode
	moved.Position = 1_200_000
	must[Progress](t)(s.SaveProgress(linked.ID, moved))
	equal(t, surfaces(), []string{"library upsert", "watched upsert", "addons upsert", "progress upsert"})

	// A delete carries the item as it was.
	check(t, s.RemoveLibraryItem(linked.ID, dune.ContentID, dune.ContentType))
	pending := must[[]Push](t)(s.Pending(linked.ID))
	last := pending[len(pending)-1]
	var removed LibraryItem
	check(t, json.Unmarshal(last.Item, &removed))
	if last.Op != OpDelete || !reflect.DeepEqual(removed, dune) {
		t.Fatalf("delete push = %s %s", last.Op, last.Item)
	}
	equal(t, surfaces(), []string{"watched upsert", "addons upsert", "progress upsert", "library delete"})

	// A failed push stays queued and counts the attempt.
	addons := pending[1]
	check(t, s.FailPush(linked.ID, addons, errors.New("HTTP 429")))
	got := must[[]Push](t)(s.Pending(linked.ID))[1]
	if got.Attempts != 1 || got.LastError != "HTTP 429" {
		t.Fatalf("after FailPush: attempts %d, error %q", got.Attempts, got.LastError)
	}

	// Acking a push that changed after it was read keeps the newer change.
	progress := pending[2]
	moved.Position = 1_500_000
	must[Progress](t)(s.SaveProgress(linked.ID, moved))
	check(t, s.AckPush(linked.ID, progress))
	check(t, s.AckPush(linked.ID, pending[0]))
	check(t, s.AckPush(linked.ID, got))
	pending = must[[]Push](t)(s.Pending(linked.ID))
	equal(t, surfaces(), []string{"library delete", "progress upsert"})
	var queued Progress
	check(t, json.Unmarshal(pending[1].Item, &queued))
	if queued.Position != 1_500_000 {
		t.Fatalf("queued position = %d, want the newer 1500000", queued.Position)
	}
}

func TestOpenTwice(t *testing.T) {
	_, path := openTemp(t)
	if _, err := Open(path); !errors.Is(err, ErrLocked) {
		t.Fatalf("second Open err = %v, want ErrLocked", err)
	}
}

// A push's key survives the outbox's JSON for any season and episode: daily
// shows and anime go past episode 127, where a binary key stops being UTF-8.
func TestOutboxWatchedLongSeries(t *testing.T) {
	s, _ := openTemp(t)
	linked := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	item := WatchedItem{ContentID: "tt0388629", ContentType: "series", Season: ptr(2), Episode: ptr(200), WatchedAt: 1}
	check(t, s.MarkWatched(linked.ID, item))
	pending := must[[]Push](t)(s.Pending(linked.ID))
	equal(t, len(pending), 1)
	check(t, s.AckPush(linked.ID, pending[0]))
	equal(t, must[[]Push](t)(s.Pending(linked.ID)), []Push{})
}
