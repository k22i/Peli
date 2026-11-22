package syncer

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"slices"
	"sync"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/backend"
	"github.com/k22i/Peli/internal/nuvio"
	"github.com/k22i/Peli/internal/nuvio/nuviotest"
	"github.com/k22i/Peli/internal/store"
)

// recorder is a monitor's emit and reconnected, safe to read while its
// goroutines run.
type recorder struct {
	mu         sync.Mutex
	emitted    []Connection
	reconnects int
}

func (r *recorder) emit(c Connection) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.emitted = append(r.emitted, c)
}

func (r *recorder) reconnected(context.Context) {
	r.mu.Lock()
	defer r.mu.Unlock()
	r.reconnects++
}

func (r *recorder) get() ([]Connection, int) {
	r.mu.Lock()
	defer r.mu.Unlock()
	return slices.Clone(r.emitted), r.reconnects
}

func eventually(t *testing.T, what string, ok func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !ok() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting until %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// The monitor learns the connection from the requests the app makes anyway,
// and tells the frontend only when it changes.
func TestMonitorFollowsRequests(t *testing.T) {
	var r recorder
	m := NewMonitor(func(context.Context) error { return nuvio.ErrUnreachable }, r.reconnected)
	m.emit = r.emit
	m.probeMin = time.Hour // no probe in this test
	t.Cleanup(m.Stop)

	if m.Connection() != Online {
		t.Fatalf("starts %q, want online so a launch shows no indicator", m.Connection())
	}
	steps := []struct {
		err  error
		want Connection
	}{
		{nil, Online},
		{fmt.Errorf("pull: %w", nuvio.ErrUnreachable), Offline},
		{errors.Join(errors.New("library"), nuvio.ErrUnreachable), Offline},
		// Signed out says nothing about the network, nor does a cancel.
		{nuvio.ErrSignedOut, Offline},
		{context.Canceled, Offline},
		{nuvio.ErrUnavailable, Unavailable},
		// Any other answer came from Nuvio, so it can be reached.
		{nuvio.ErrRateLimited, Online},
		{&nuvio.APIError{Status: 400}, Online},
	}
	for _, step := range steps {
		m.observe(step.err)
		if got := m.Connection(); got != step.want {
			t.Fatalf("after %v: %q, want %q", step.err, got, step.want)
		}
	}
	eventually(t, "it reconnected", func() bool { _, n := r.get(); return n == 1 })
	emitted, _ := r.get()
	if want := []Connection{Offline, Unavailable, Online}; !slices.Equal(emitted, want) {
		t.Fatalf("emitted %v, want %v", emitted, want)
	}
}

// While offline it checks by itself, more and more slowly, and stops once it
// gets through. Nuvio being down isn't probed: the poll and the push backoff
// find out when it's back.
func TestMonitorProbesWhileOffline(t *testing.T) {
	var r recorder
	var mu sync.Mutex
	pings, up := 0, false
	m := NewMonitor(func(context.Context) error {
		mu.Lock()
		defer mu.Unlock()
		pings++
		if up {
			return nil
		}
		return nuvio.ErrUnreachable
	}, r.reconnected)
	m.emit = r.emit
	m.probeMin, m.probeMax = time.Millisecond, 4*time.Millisecond
	m.Start(t.Context())
	t.Cleanup(m.Stop)

	m.observe(nuvio.ErrUnreachable)
	eventually(t, "it probed a few times", func() bool { mu.Lock(); defer mu.Unlock(); return pings >= 4 })
	m.mu.Lock()
	wait := m.wait
	m.mu.Unlock()
	if wait != m.probeMax {
		t.Fatalf("probe wait %v, want it backed off to %v", wait, m.probeMax)
	}

	mu.Lock()
	up = true
	mu.Unlock()
	eventually(t, "it noticed the network", func() bool { return m.Connection() == Online })
	eventually(t, "it reconnected", func() bool { _, n := r.get(); return n == 1 })
	mu.Lock()
	seen := pings
	mu.Unlock()
	time.Sleep(20 * time.Millisecond)
	mu.Lock()
	defer mu.Unlock()
	if pings != seen {
		t.Fatal("still probing while online")
	}

	m.observe(nuvio.ErrUnavailable)
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.timer != nil {
		t.Fatal("probing while Nuvio is down")
	}
}

// Check asks at once when offline, and not at all when online.
func TestMonitorCheck(t *testing.T) {
	var r recorder
	pings := 0
	answer := nuvio.ErrUnreachable
	m := NewMonitor(func(context.Context) error { pings++; return answer }, r.reconnected)
	m.probeMin = time.Hour
	t.Cleanup(m.Stop)

	if m.Check(t.Context()) != Online || pings != 0 {
		t.Fatalf("checked while online (%d pings)", pings)
	}
	m.observe(nuvio.ErrUnreachable)
	if m.Check(t.Context()) != Offline || pings != 1 {
		t.Fatalf("check while offline: %d pings", pings)
	}
	answer = nil
	if m.Check(t.Context()) != Online {
		t.Fatal("the check didn't get through")
	}
	eventually(t, "it reconnected", func() bool { _, n := r.get(); return n == 1 })
}

// PullNow ignores the 30 s throttle, for the network coming back.
func TestPullNowIgnoresTheGap(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	puller, _, _ := desktop.puller()

	_, err := puller.Pull(t.Context())
	check(t, err)
	before := calls(server)
	_, err = puller.Pull(t.Context())
	check(t, err)
	if calls(server) != before {
		t.Fatal("Pull didn't throttle")
	}
	_, err = puller.PullNow(t.Context())
	check(t, err)
	if calls(server) == before {
		t.Fatal("PullNow was throttled")
	}
}

// app is the sync service of one Peli install, wired as main wires it, with
// a profile linked to Nuvio profile 1.
type app struct {
	db      *store.Store
	profile store.Profile
	sync    *Service
}

func newApp(t *testing.T, server *nuviotest.Server) *app {
	t.Helper()
	dbService := store.NewService(filepath.Join(t.TempDir(), "peli.db"))
	client := nuvio.New(server.URL, "1.2.3")
	session, err := client.SignInWithPassword(t.Context(), email, nuviotest.Password)
	check(t, err)
	s := NewService(dbService, backend.Nuvio{Client: client, Sessions: &sessions{session: session}})
	s.monitor.probeMin, s.monitor.probeMax = 5*time.Millisecond, 20*time.Millisecond
	s.pusher.debounce, s.pusher.maxWait = 5*time.Millisecond, 20*time.Millisecond
	s.pusher.progressEvery = 5 * time.Millisecond
	s.pusher.backoffMin = time.Hour // only reconnecting retries in this test

	check(t, dbService.ServiceStartup(t.Context(), application.ServiceOptions{}))
	t.Cleanup(func() { dbService.ServiceShutdown() })
	db := store.Opened(dbService)
	profile, err := db.CreateProfile(store.Profile{Name: "Kevin", NuvioIndex: ptr(1)})
	check(t, err)
	check(t, db.SetCurrentProfile(profile.ID))
	return &app{db, profile, s}
}

// The acceptance criterion: with no network the app opens with the library
// and Continue Watching, says it's offline, and what changed offline syncs
// once the network is back, after which what other devices changed comes in.
func TestOfflineLaunchAndReconnect(t *testing.T) {
	server := nuviotest.NewServer(t)
	phone, desktop := newDevice(t, server), newApp(t, server)

	// Synced on a previous run.
	check(t, desktop.db.SaveLibraryItem(desktop.profile.ID, dune))
	_, err := desktop.db.SaveProgress(desktop.profile.ID, episode)
	check(t, err)
	check(t, desktop.sync.Flush(t.Context()))

	// Meanwhile the phone adds a title; then the desktop loses the network.
	arrival := store.LibraryItem{ContentID: "tt0816692", ContentType: "movie", Name: "Interstellar", PosterShape: "POSTER", AddedAt: 3000}
	check(t, phone.store.SaveLibraryItem(phone.profile.ID, arrival))
	phone.push(t)
	server.Offline.Store(true)

	// Launch.
	check(t, desktop.sync.ServiceStartup(t.Context(), application.ServiceOptions{}))
	t.Cleanup(func() { desktop.sync.ServiceShutdown() })
	if _, err := PullerOf(desktop.sync).Pull(t.Context()); !backend.Unreachable(err) {
		t.Fatalf("offline pull = %v", err)
	}
	if got := desktop.sync.Connection(); got != Offline {
		t.Fatalf("connection %q, want offline", got)
	}
	library, err := desktop.db.Library(desktop.profile.ID)
	check(t, err)
	watching, err := desktop.db.ContinueWatching(desktop.profile.ID)
	check(t, err)
	if len(library) != 1 || len(watching) != 1 {
		t.Fatalf("offline: library %+v, continue watching %+v", library, watching)
	}

	// Changes made offline wait in the outbox.
	later := episode
	later.Position, later.LastWatched = 1_200_000, 6_000_000
	_, err = desktop.db.SaveProgress(desktop.profile.ID, later)
	check(t, err)
	check(t, desktop.db.RemoveLibraryItem(desktop.profile.ID, dune.ContentID, dune.ContentType))
	eventually(t, "the push was tried", func() bool {
		queued, err := desktop.db.Pending(desktop.profile.ID)
		return err == nil && len(queued) == 2 && slices.ContainsFunc(queued, func(p store.Push) bool { return p.Attempts > 0 })
	})
	if desktop.sync.CheckConnection(t.Context()) != Offline {
		t.Fatal("check got through offline")
	}

	// The network is back: the probe notices, the outbox goes out, then the
	// pull brings in the phone's title though the last pull was just now.
	server.Offline.Store(false)
	eventually(t, "it's back online", func() bool { return desktop.sync.Connection() == Online })
	eventually(t, "the outbox was sent", func() bool {
		queued, err := desktop.db.Pending(desktop.profile.ID)
		return err == nil && len(queued) == 0
	})
	eventually(t, "the phone's title came in", func() bool {
		library, err := desktop.db.Library(desktop.profile.ID)
		return err == nil && len(library) == 1 && library[0].ContentID == arrival.ContentID
	})
	progress := server.Rows(email, 1, nuviotest.Progress)
	if len(progress) != 1 || progress[0]["position"] != float64(later.Position) {
		t.Fatalf("server progress = %+v", progress)
	}
	if lib := server.Rows(email, 1, nuviotest.Library); len(lib) != 1 || lib[0]["content_id"] != arrival.ContentID {
		t.Fatalf("server library = %+v", lib)
	}
}

// Coming back from suspension while offline probes at once and starts the
// probe intervals over, instead of waiting out the one armed before (which a
// stopped clock can stretch); online, it does nothing.
func TestMonitorWakeProbesNow(t *testing.T) {
	var r recorder
	var mu sync.Mutex
	pings := 0
	down := true
	m := NewMonitor(func(context.Context) error {
		mu.Lock()
		defer mu.Unlock()
		pings++
		if down {
			return nuvio.ErrUnreachable
		}
		return nil
	}, r.reconnected)
	m.emit = r.emit
	m.probeMin, m.probeMax = time.Hour, time.Hour // the armed probe is far away
	t.Cleanup(m.Stop)

	m.Wake()
	time.Sleep(50 * time.Millisecond)
	mu.Lock()
	if pings != 0 {
		t.Fatalf("online wake pinged %d times, want 0", pings)
	}
	mu.Unlock()

	m.observe(nuvio.ErrUnreachable) // offline, next probe in an hour
	m.Wake()
	eventually(t, "the wake probe", func() bool { mu.Lock(); defer mu.Unlock(); return pings == 1 })

	mu.Lock()
	down = false
	mu.Unlock()
	m.Wake()
	eventually(t, "back online", func() bool { return m.Connection() == Online })
	// reconnected runs on its own goroutine, after Online.
	eventually(t, "one reconnect", func() bool { _, n := r.get(); return n == 1 })
	m.Stop()
	if _, reconnects := r.get(); reconnects != 1 {
		t.Fatalf("reconnects = %d, want 1", reconnects)
	}
}
