package backend

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"reflect"
	"testing"

	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/nuvio/nuviotest"
	"github.com/k22i/Sinag/internal/store"
)

const email = "me@example.com"

func ptr[T any](v T) *T { return &v }

func check(t testing.TB, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

// fixedSession is a Sessions that always has a session, and counts the calls.
type fixedSession struct {
	session nuvio.Session
	calls   int
	err     error
}

func (f *fixedSession) Do(_ context.Context, fn func(nuvio.Session) error) error {
	f.calls++
	if f.err != nil {
		return f.err
	}
	return fn(f.session)
}

// device is one Sinag install: a store with a profile linked to Nuvio profile
// 1, and the backend to sync it with. All devices share the one server.
type device struct {
	store    *store.Store
	profile  store.Profile
	backend  Nuvio
	sessions *fixedSession
}

func newDevice(t *testing.T, server *nuviotest.Server) *device {
	t.Helper()
	s, err := store.Open(filepath.Join(t.TempDir(), "sinag.db"))
	check(t, err)
	t.Cleanup(func() { s.Close() })
	profile, err := s.CreateProfile(store.Profile{Name: "Kevin", NuvioIndex: ptr(1)})
	check(t, err)

	client := nuvio.New(server.URL, "1.2.3")
	session, err := client.SignInWithPassword(t.Context(), email, nuviotest.Password)
	check(t, err)
	sessions := &fixedSession{session: session}
	return &device{s, profile, Nuvio{Client: client, Sessions: sessions}, sessions}
}

// push sends everything queued and acks what the backend has.
func (d *device) push(t *testing.T) {
	t.Helper()
	pending, err := d.store.Pending(d.profile.ID)
	check(t, err)
	acked, err := d.backend.Push(t.Context(), d.profile, pending)
	check(t, err)
	for _, p := range acked {
		check(t, d.store.AckPush(d.profile.ID, p))
	}
	if left, _ := d.store.Pending(d.profile.ID); len(left) != 0 {
		t.Fatalf("%d pushes left in the outbox", len(left))
	}
}

// pull reads every surface from its stored cursor and applies it, as #29 will.
// It returns how many changes it applied.
func (d *device) pull(t *testing.T) (applied int) {
	t.Helper()
	for _, surface := range []store.Surface{store.SurfaceLibrary, store.SurfaceProgress, store.SurfaceWatched, store.SurfaceAddons, store.SurfacePlugins} {
		cursor, ok, err := d.store.Cursor(d.profile.ID, surface)
		check(t, err)
		changes, next, err := d.backend.Pull(t.Context(), d.profile, surface, cursor, ok)
		check(t, err)
		n, err := d.store.ApplyChanges(d.profile.ID, changes)
		check(t, err)
		applied += n
		check(t, d.store.SetCursor(d.profile.ID, surface, next))
	}
	return applied
}

// What one device writes, another reads, and the writer's own echo changes
// nothing (#28's acceptance for the Nuvio implementation).
func TestSyncBetweenDevices(t *testing.T) {
	server := nuviotest.NewServer(t)
	phone, desktop := newDevice(t, server), newDevice(t, server)

	dune := store.LibraryItem{ContentID: "tt1160419", ContentType: "movie", Name: "Dune", PosterShape: "POSTER",
		IMDBRating: ptr(8.0), Genres: []string{"Sci-Fi"}, AddedAt: 2000}
	episode := store.Progress{ContentID: "tt11280740", ContentType: "series", VideoID: "tt11280740:1:2",
		Season: ptr(1), Episode: ptr(2), Position: 600_000, Duration: 3_000_000, LastWatched: 5_000_000}
	long := store.WatchedItem{ContentID: "tt0388629", ContentType: "series", Title: "One Piece", Season: ptr(2), Episode: ptr(200), WatchedAt: 9}
	addons := []store.Addon{
		{URL: "https://v3-cinemeta.strem.io/manifest.json", Name: "Cinemeta", Enabled: true},
		{URL: "https://opensubtitles-v3.strem.io/manifest.json", Name: "OpenSubtitles", Enabled: false},
	}

	id := desktop.profile.ID
	check(t, desktop.store.SaveLibraryItem(id, dune))
	saved, err := desktop.store.SaveProgress(id, episode)
	check(t, err)
	check(t, desktop.store.MarkWatched(id, long))
	check(t, desktop.store.SetAddons(id, addons))
	desktop.push(t)

	// The phone gets all of it.
	if n := phone.pull(t); n != 4 {
		t.Fatalf("phone applied %d changes, want 4", n)
	}
	pid := phone.profile.ID
	if got, _ := phone.store.Library(pid); !reflect.DeepEqual(got, []store.LibraryItem{dune}) {
		t.Fatalf("library = %+v", got)
	}
	if got, _ := phone.store.TitleProgress(pid, episode.ContentID); !reflect.DeepEqual(got, []store.Progress{saved}) {
		t.Fatalf("progress = %+v, want %+v", got, saved)
	}
	if got, _ := phone.store.Watched(pid); !reflect.DeepEqual(got, []store.WatchedItem{long}) {
		t.Fatalf("watched = %+v", got)
	}
	if got, _ := phone.store.Addons(pid); !reflect.DeepEqual(got, addons) {
		t.Fatalf("addons = %+v", got)
	}
	if pending, _ := phone.store.Pending(pid); len(pending) != 0 {
		t.Fatalf("applying a pull queued %+v", pending)
	}

	// The desktop's own writes echo back. They match what it has: nothing to do.
	// (Addons come back whole every time, and also match.)
	if n := desktop.pull(t); n != 0 {
		t.Fatalf("desktop applied %d changes of its own echo", n)
	}
	// Nothing new since the cursors.
	if n := phone.pull(t); n != 0 {
		t.Fatalf("phone applied %d changes with nothing new", n)
	}

	// Deletes travel too, carrying the row, and the addon list goes back to one.
	check(t, phone.store.RemoveLibraryItem(pid, dune.ContentID, dune.ContentType))
	check(t, phone.store.UnmarkWatched(pid, long.ContentID, long.Season, long.Episode))
	check(t, phone.store.RemoveProgress(pid, saved.Key))
	check(t, phone.store.SetAddons(pid, addons[:1]))
	phone.push(t)
	if n := desktop.pull(t); n != 4 {
		t.Fatalf("desktop applied %d changes, want 4", n)
	}
	if lib, _ := desktop.store.Library(id); len(lib) != 0 {
		t.Fatalf("library = %+v", lib)
	}
	if w, _ := desktop.store.Watched(id); len(w) != 0 {
		t.Fatalf("watched = %+v", w)
	}
	if got, _ := desktop.store.Addons(id); !reflect.DeepEqual(got, addons[:1]) {
		t.Fatalf("addons = %+v", got)
	}
	if rows := server.Rows(email, 1, nuviotest.Progress); len(rows) != 0 {
		t.Fatalf("server still has progress %v", rows)
	}
}

// A pull with no stored cursor reads the whole feed, page after page, and
// returns the last event as the cursor.
func TestPullPages(t *testing.T) {
	server := nuviotest.NewServer(t)
	d := newDevice(t, server)
	const total = nuvio.DeltaLimit*2 + 7
	for i := range total {
		check(t, d.store.SaveLibraryItem(d.profile.ID, store.LibraryItem{
			ContentID: fmt.Sprintf("tt%07d", i), ContentType: "movie", Name: "x", AddedAt: int64(i),
		}))
	}
	d.push(t)

	other := newDevice(t, server)
	changes, next, err := other.backend.Pull(t.Context(), other.profile, store.SurfaceLibrary, 0, false)
	check(t, err)
	if len(changes) != total {
		t.Fatalf("pulled %d changes, want %d", len(changes), total)
	}
	last := server.Rows(email, 1, nuviotest.Library)
	if len(last) != total {
		t.Fatalf("server has %d", len(last))
	}
	// Asking again from that cursor finds nothing and keeps it.
	again, same, err := other.backend.Pull(t.Context(), other.profile, store.SurfaceLibrary, next, true)
	check(t, err)
	if len(again) != 0 || same != next {
		t.Fatalf("second pull = %d changes, cursor %d, want none and %d", len(again), same, next)
	}
	// Changes name their item the way the outbox does.
	key, err := store.PushKey(store.SurfaceLibrary, changes[0].Item)
	check(t, err)
	if changes[0].Key != key || changes[0].Op != store.OpUpsert || changes[0].Surface != store.SurfaceLibrary {
		t.Fatalf("change = %+v", changes[0])
	}
}

func TestNotLinked(t *testing.T) {
	n := Nuvio{Client: nuvio.New("http://127.0.0.1:1", "1"), Sessions: &fixedSession{}}
	guest := store.Profile{ID: 1, Name: "Guest", Guest: true}
	if _, _, err := n.Pull(t.Context(), guest, store.SurfaceLibrary, 0, false); !errors.Is(err, ErrNotLinked) {
		t.Errorf("Pull: err = %v", err)
	}
	if _, err := n.Push(t.Context(), guest, nil); !errors.Is(err, ErrNotLinked) {
		t.Errorf("Push: err = %v", err)
	}
}

// A signed-out session stops the push and acks nothing; a pull returns the
// error and keeps the cursor.
func TestSignedOut(t *testing.T) {
	d := newDevice(t, nuviotest.NewServer(t))
	check(t, d.store.SaveLibraryItem(d.profile.ID, store.LibraryItem{ContentID: "tt1", ContentType: "movie", Name: "A"}))
	check(t, d.store.SetAddons(d.profile.ID, nil))
	pending, _ := d.store.Pending(d.profile.ID)

	d.sessions.err = nuvio.ErrSignedOut
	acked, err := d.backend.Push(t.Context(), d.profile, pending)
	if !errors.Is(err, nuvio.ErrSignedOut) || len(acked) != 0 {
		t.Fatalf("Push = %v, %v", acked, err)
	}
	if d.sessions.calls != 1 {
		t.Fatalf("%d calls after being signed out, want 1", d.sessions.calls)
	}
	changes, next, err := d.backend.Pull(t.Context(), d.profile, store.SurfaceProgress, 42, true)
	if !errors.Is(err, nuvio.ErrSignedOut) || changes != nil || next != 42 {
		t.Fatalf("Pull = %v, %d, %v", changes, next, err)
	}
}

// One batch the server refuses doesn't hold back the others, and isn't acked.
func TestPushKeepsGoingPastABadBatch(t *testing.T) {
	server := nuviotest.NewServer(t)
	d := newDevice(t, server)
	id := d.profile.ID
	check(t, d.store.SaveLibraryItem(id, store.LibraryItem{ContentID: "tt1", ContentType: "movie", Name: "A"}))
	check(t, d.store.MarkWatched(id, store.WatchedItem{ContentID: "tt1", ContentType: "movie", WatchedAt: 1}))
	pending, _ := d.store.Pending(id)

	// Profile 7 doesn't exist: P0001 for every batch.
	d.profile.NuvioIndex = ptr(7)
	acked, err := d.backend.Push(t.Context(), d.profile, pending)
	var api *nuvio.APIError
	if !errors.As(err, &api) || len(acked) != 0 || d.sessions.calls != 2 {
		t.Fatalf("Push = %v, %v after %d calls", acked, err, d.sessions.calls)
	}

	// An item that isn't JSON fails its batch alone.
	d.profile.NuvioIndex = ptr(1)
	pending[0].Item = []byte(`{`)
	acked, err = d.backend.Push(t.Context(), d.profile, pending)
	if err == nil || len(acked) != 1 || acked[0].Surface != store.SurfaceWatched {
		t.Fatalf("Push = %+v, %v, want the watched push only", acked, err)
	}
}

// Large outboxes go in pages of pushBatch rows, and a delete is a separate call.
func TestPushBatches(t *testing.T) {
	var pushes []store.Push
	for i := range pushBatch*2 + 1 {
		pushes = append(pushes, store.Push{Surface: store.SurfaceLibrary, Op: store.OpUpsert, Key: fmt.Sprint(i)})
	}
	pushes = append(pushes,
		store.Push{Surface: store.SurfaceLibrary, Op: store.OpDelete},
		store.Push{Surface: store.SurfaceAddons, Op: store.OpUpsert, Seq: 1},
		store.Push{Surface: store.SurfaceAddons, Op: store.OpUpsert, Seq: 2},
		store.Push{Surface: store.SurfaceAddons, Op: store.OpDelete},
		store.Push{Surface: "plugins", Op: store.OpUpsert},
	)
	var sizes []string
	for _, b := range batches(pushes) {
		sizes = append(sizes, fmt.Sprintf("%s %s %d", b.surface, b.op, len(b.pushes)))
	}
	want := []string{"library upsert 500", "library upsert 500", "library upsert 1", "library delete 1", "addons upsert 2", "addons delete 1", "plugins upsert 1"}
	if !reflect.DeepEqual(sizes, want) {
		t.Fatalf("batches = %q, want %q", sizes, want)
	}
}

// An addons push carries the whole list and replaces the server's; the newest
// push is the one sent.
func TestAddonsPushIsTheWholeList(t *testing.T) {
	server := nuviotest.NewServer(t)
	d := newDevice(t, server)
	one := []store.Addon{{URL: "https://a/manifest.json", Name: "A", Enabled: true}}
	two := append(one, store.Addon{URL: "https://b/manifest.json", Name: "B", Enabled: true})
	check(t, d.store.SetAddons(d.profile.ID, two))
	d.push(t)
	check(t, d.store.SetAddons(d.profile.ID, one))
	d.push(t)
	if rows := server.SyncedAddons(email, 1); len(rows) != 1 || rows[0]["url"] != one[0].URL {
		t.Fatalf("server has %v", rows)
	}
	// Emptying the list is a real change of the user's: the empty list goes.
	check(t, d.store.SetAddons(d.profile.ID, nil))
	d.push(t)
	if rows := server.SyncedAddons(email, 1); len(rows) != 0 {
		t.Fatalf("server has %v", rows)
	}
}

// A push Nuvio has no call for isn't acked and says why.
func TestPushUnsupported(t *testing.T) {
	d := newDevice(t, nuviotest.NewServer(t))
	for _, p := range []store.Push{
		{Surface: "plugins", Op: store.OpUpsert, Item: []byte(`[]`)},
		{Surface: store.SurfaceAddons, Op: store.OpDelete, Item: []byte(`[]`)},
		{Surface: store.SurfaceLibrary, Op: "merge", Item: []byte(`{}`)},
	} {
		acked, err := d.backend.Push(t.Context(), d.profile, []store.Push{p})
		if err == nil || len(acked) != 0 {
			t.Errorf("Push(%s %s) = %v, %v", p.Surface, p.Op, acked, err)
		}
	}
}
