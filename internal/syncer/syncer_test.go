package syncer

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/k22i/Sinag/internal/backend"
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

// sessions is a backend.Sessions that always has a session, or err.
type sessions struct {
	session nuvio.Session
	err     error
	calls   int
}

func (s *sessions) Do(_ context.Context, fn func(nuvio.Session) error) error {
	s.calls++
	if s.err != nil {
		return s.err
	}
	return fn(s.session)
}

// device is one Sinag install with a profile linked to Nuvio profile 1.
type device struct {
	path     string
	store    *store.Store
	profile  store.Profile
	backend  backend.Nuvio
	sessions *sessions
}

func newDevice(t *testing.T, server *nuviotest.Server) *device {
	t.Helper()
	return newDeviceAt(t, server.URL, email, nuviotest.Password)
}

// newDeviceAt is newDevice for any backend and account.
func newDeviceAt(t *testing.T, url, email, password string) *device {
	t.Helper()
	path := filepath.Join(t.TempDir(), "sinag.db")
	s, err := store.Open(path)
	check(t, err)
	t.Cleanup(func() { s.Close() })
	profile, err := s.CreateProfile(store.Profile{Name: "Kevin", NuvioIndex: ptr(1)})
	check(t, err)
	check(t, s.SetCurrentProfile(profile.ID))

	client := nuvio.New(url, "1.2.3")
	session, err := client.SignInWithPassword(t.Context(), email, password)
	check(t, err)
	sess := &sessions{session: session}
	return &device{path, s, profile, backend.Nuvio{Client: client, Sessions: sess}, sess}
}

// push sends what the device has queued, as the push loop (#30) will.
func (d *device) push(t *testing.T) {
	t.Helper()
	pending, err := d.store.Pending(d.profile.ID)
	check(t, err)
	acked, err := d.backend.Push(t.Context(), d.profile, pending)
	check(t, err)
	for _, p := range acked {
		check(t, d.store.AckPush(d.profile.ID, p))
	}
}

// puller returns a puller for the device with a clock the test moves, and the
// events it emitted.
func (d *device) puller() (*Puller, *time.Time, *[]Pulled) {
	p := NewPuller(func() *store.Store { return d.store }, d.backend)
	clock := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	p.now = func() time.Time { return clock }
	var emitted []Pulled
	p.emit = func(pulled Pulled) { emitted = append(emitted, pulled) }
	return p, &clock, &emitted
}

var (
	// The server fills in a poster shape, so the echo of a save without one differs.
	dune    = store.LibraryItem{ContentID: "tt1160419", ContentType: "movie", Name: "Dune", PosterShape: "POSTER", AddedAt: 2000}
	episode = store.Progress{
		ContentID: "tt11280740", ContentType: "series", VideoID: "tt11280740:1:2",
		Season: ptr(1), Episode: ptr(2), Position: 600_000, Duration: 3_000_000, LastWatched: 5_000_000,
	}
)

func calls(server *nuviotest.Server) int {
	n := 0
	for _, c := range server.Calls() {
		if strings.Contains(c, "sync_pull_") {
			n++
		}
	}
	return n
}

// The acceptance criterion: progress changed on the phone appears on the
// desktop after it pulls, and the pull reads from the stored cursors.
func TestPullBringsInWhatAnotherDeviceChanged(t *testing.T) {
	server := nuviotest.NewServer(t)
	phone, desktop := newDevice(t, server), newDevice(t, server)
	puller, clock, emitted := desktop.puller()

	// First launch: nothing there yet, but the cursors are read.
	pulled, err := puller.Pull(t.Context())
	check(t, err)
	if len(pulled.Surfaces) != 0 || len(*emitted) != 0 {
		t.Fatalf("pulled %+v from an empty account, emitted %v", pulled, *emitted)
	}
	if got := calls(server); got != 3 {
		t.Fatalf("first pull made %d feed calls, want 3 (library, progress, watched)", got)
	}

	check(t, phone.store.SaveLibraryItem(phone.profile.ID, dune))
	saved, err := phone.store.SaveProgress(phone.profile.ID, episode)
	check(t, err)
	phone.push(t)

	// Too soon: the desktop doesn't even ask.
	*clock = clock.Add(MinGap / 2)
	before := calls(server)
	if _, err := puller.Pull(t.Context()); err != nil || calls(server) != before {
		t.Fatalf("a pull %v after the last made %d calls, err %v", MinGap/2, calls(server)-before, err)
	}

	// Focused again later.
	*clock = clock.Add(MinGap)
	pulled, err = puller.Pull(t.Context())
	check(t, err)
	want := Pulled{ProfileID: desktop.profile.ID, Surfaces: []store.Surface{store.SurfaceLibrary, store.SurfaceProgress, store.SurfaceWatched}}
	// The server marks the episode watched at 90 %; this one is at 20 %.
	want.Surfaces = slices.DeleteFunc(want.Surfaces, func(s store.Surface) bool { return s == store.SurfaceWatched })
	if !reflect.DeepEqual(pulled, want) || !reflect.DeepEqual(*emitted, []Pulled{want}) {
		t.Fatalf("pulled %+v, emitted %+v, want %+v", pulled, *emitted, want)
	}
	if got, _ := desktop.store.ContinueWatching(desktop.profile.ID); !reflect.DeepEqual(got, []store.Progress{saved}) {
		t.Fatalf("continue watching = %+v, want %+v", got, saved)
	}
	if got, _ := desktop.store.Library(desktop.profile.ID); !reflect.DeepEqual(got, []store.LibraryItem{dune}) {
		t.Fatalf("library = %+v", got)
	}
	if pending, _ := desktop.store.Pending(desktop.profile.ID); len(pending) != 0 {
		t.Fatalf("a pull queued %+v", pending)
	}
	for _, surface := range []store.Surface{store.SurfaceLibrary, store.SurfaceProgress} {
		if cursor, ok, _ := desktop.store.Cursor(desktop.profile.ID, surface); !ok || cursor == 0 {
			t.Fatalf("%s cursor = %d, %v", surface, cursor, ok)
		}
	}

	// Pulled from the cursor, not from the start: a pull with nothing new
	// changes nothing and emits nothing.
	*clock = clock.Add(MinGap)
	if pulled, err = puller.Pull(t.Context()); err != nil || len(pulled.Surfaces) != 0 || len(*emitted) != 1 {
		t.Fatalf("pulled %+v, err %v, emitted %d", pulled, err, len(*emitted))
	}
	cursor, _, _ := desktop.store.Cursor(desktop.profile.ID, store.SurfaceProgress)
	if since := server.Body("/rest/v1/rpc/sync_pull_watch_progress_delta")["p_since_event_id"]; since != float64(cursor) {
		t.Fatalf("pulled from %v, want the stored cursor %d", since, cursor)
	}

	// Deletes come across too.
	check(t, phone.store.RemoveLibraryItem(phone.profile.ID, dune.ContentID, dune.ContentType))
	phone.push(t)
	*clock = clock.Add(MinGap)
	if _, err = puller.Pull(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got, _ := desktop.store.Library(desktop.profile.ID); len(got) != 0 {
		t.Fatalf("library = %+v after the delete", got)
	}
}

// Our own pushes come back in the feed and change nothing.
func TestPullIgnoresOwnEcho(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	puller, _, emitted := desktop.puller()

	check(t, desktop.store.SaveLibraryItem(desktop.profile.ID, dune))
	_, err := desktop.store.SaveProgress(desktop.profile.ID, episode)
	check(t, err)
	desktop.push(t)

	pulled, err := puller.Pull(t.Context())
	check(t, err)
	if len(pulled.Surfaces) != 0 || len(*emitted) != 0 {
		t.Fatalf("our own writes changed %+v", pulled)
	}
}

// The newer of two positions wins, whichever device it came from (the rule
// is in the doc of store.ApplyChanges).
func TestPullProgressLatestWins(t *testing.T) {
	server := nuviotest.NewServer(t)
	phone, desktop := newDevice(t, server), newDevice(t, server)
	puller, clock, _ := desktop.puller()
	position := func() int64 {
		got, err := desktop.store.TitleProgress(desktop.profile.ID, episode.ContentID)
		check(t, err)
		return got[0].Position
	}

	_, err := phone.store.SaveProgress(phone.profile.ID, episode)
	check(t, err)
	phone.push(t)
	_, err = puller.Pull(t.Context())
	check(t, err)

	// The desktop watches further and pushes; the server drops that push
	// when it is too soon after the last one, and answers 200 all the same.
	further := episode
	further.Position, further.LastWatched = episode.Position+10_000, episode.LastWatched+10_000
	_, err = desktop.store.SaveProgress(desktop.profile.ID, further)
	check(t, err)
	desktop.push(t)
	if server.DroppedProgress() == 0 {
		t.Fatal("the fake should have dropped that push")
	}
	*clock = clock.Add(MinGap)
	_, err = puller.Pull(t.Context())
	check(t, err)
	if got := position(); got != further.Position {
		t.Fatalf("position = %d: the pull brought back the older one, want %d", got, further.Position)
	}

	// Watched later on the phone: that one wins.
	later := episode
	later.Position, later.LastWatched = 1_200_000, further.LastWatched+60_000 // far enough not to be dropped
	_, err = phone.store.SaveProgress(phone.profile.ID, later)
	check(t, err)
	phone.push(t)
	*clock = clock.Add(MinGap)
	_, err = puller.Pull(t.Context())
	check(t, err)
	if got := position(); got != later.Position {
		t.Fatalf("position = %d, want the phone's %d", got, later.Position)
	}
}

// Without a Nuvio profile there is nothing to pull and no request is made.
func TestPullSkipsLocalProfiles(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	guest, err := desktop.store.SwitchToGuest()
	check(t, err)
	if guest.NuvioIndex != nil {
		t.Fatal("the Guest is linked")
	}
	puller, _, _ := desktop.puller()
	before := desktop.sessions.calls

	pulled, err := puller.Pull(t.Context())
	check(t, err)
	if len(pulled.Surfaces) != 0 || desktop.sessions.calls != before || calls(server) != 0 {
		t.Fatalf("pulled %+v, %d session uses, %d requests", pulled, desktop.sessions.calls-before, calls(server))
	}
}

// A failed pull leaves the cursors where they were and is tried again, even
// within the gap, once the user acts: the next one is just a later pull.
func TestPullFailureKeepsCursors(t *testing.T) {
	server := nuviotest.NewServer(t)
	phone, desktop := newDevice(t, server), newDevice(t, server)
	puller, clock, emitted := desktop.puller()

	check(t, phone.store.SaveLibraryItem(phone.profile.ID, dune))
	phone.push(t)

	for _, down := range []error{nuvio.ErrSignedOut, nuvio.ErrUnreachable} {
		desktop.sessions.err = down
		if _, err := puller.Pull(t.Context()); !errors.Is(err, down) {
			t.Fatalf("err = %v, want %v", err, down)
		}
		if !backend.Offline(down) {
			t.Fatalf("%v should be quiet", down)
		}
		if _, ok, _ := desktop.store.Cursor(desktop.profile.ID, store.SurfaceLibrary); ok {
			t.Fatalf("a failed pull stored a cursor")
		}
		*clock = clock.Add(MinGap)
	}

	desktop.sessions.err = nil
	pulled, err := puller.Pull(t.Context())
	check(t, err)
	if !slices.Contains(pulled.Surfaces, store.SurfaceLibrary) || len(*emitted) != 1 {
		t.Fatalf("pulled %+v after coming back", pulled)
	}
}

// A row the store refuses is dropped; the rest of the page is applied and the
// cursor moves on.
func TestApplySkipsInvalidChanges(t *testing.T) {
	server := nuviotest.NewServer(t)
	d := newDevice(t, server)
	good := backend.Change{Surface: store.SurfaceLibrary, Op: store.OpUpsert, Item: []byte(`{"contentId":"tt1","contentType":"movie","name":"A"}`)}
	bad := backend.Change{Surface: store.SurfaceLibrary, Op: store.OpUpsert, Item: []byte(`{"contentType":"movie"}`)}

	n, err := apply(d.store, d.profile.ID, []backend.Change{bad, good})
	check(t, err)
	if lib, _ := d.store.Library(d.profile.ID); n != 1 || len(lib) != 1 {
		t.Fatalf("applied %d, library %+v", n, lib)
	}
}

// The addon list comes in with every pull, though it has no feed, and the
// frontend hears of it only when it changed (#32).
func TestPullBringsInAddons(t *testing.T) {
	server := nuviotest.NewServer(t)
	phone, desktop := newDevice(t, server), newDevice(t, server)
	puller, clock, emitted := desktop.puller()
	cinemeta := store.Addon{URL: "https://v3-cinemeta.strem.io/manifest.json", Name: "Cinemeta", Enabled: true}

	check(t, phone.store.InstallAddon(phone.profile.ID, cinemeta))
	phone.push(t)
	pulled, err := puller.Pull(t.Context())
	check(t, err)
	want := Pulled{ProfileID: desktop.profile.ID, Surfaces: []store.Surface{store.SurfaceAddons}}
	if !reflect.DeepEqual(pulled, want) || !reflect.DeepEqual(*emitted, []Pulled{want}) {
		t.Fatalf("pulled %+v, emitted %+v, want %+v", pulled, *emitted, want)
	}
	if got, _ := desktop.store.Addons(desktop.profile.ID); !reflect.DeepEqual(got, []store.Addon{cinemeta}) {
		t.Fatalf("addons = %+v", got)
	}

	// The same list again: read, but nothing to tell.
	*clock = clock.Add(MinGap)
	if pulled, err = puller.Pull(t.Context()); err != nil || len(pulled.Surfaces) != 0 || len(*emitted) != 1 {
		t.Fatalf("pulled %+v, err %v, emitted %d", pulled, err, len(*emitted))
	}
	if got := server.Calls(); !slices.ContainsFunc(got, func(c string) bool { return strings.Contains(c, "/rest/v1/addons") }) {
		t.Fatalf("no addons read in %v", got)
	}
}
