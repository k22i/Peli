package syncer

import (
	"context"
	"errors"
	"slices"
	"testing"
	"time"

	"github.com/k22i/Sinag/internal/backend"
	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/nuvio/nuviotest"
	"github.com/k22i/Sinag/internal/store"
)

// pusher returns a pusher for the device with a clock the test moves. Tests
// that need the timer use realPusher.
func (d *device) pusher() (*Pusher, *time.Time) {
	p := NewPusher(func() *store.Store { return d.store }, d.backend)
	clock := time.Date(2026, 10, 21, 12, 0, 0, 0, time.UTC)
	p.now = func() time.Time { return clock }
	return p, &clock
}

func pending(t *testing.T, d *device) []store.Push {
	t.Helper()
	got, err := d.store.Pending(d.profile.ID)
	check(t, err)
	return got
}

func rows(server *nuviotest.Server, surface string) int {
	return len(server.Rows(email, 1, surface))
}

// What the user does on the desktop reaches the account without anyone
// asking, within the debounce: the acceptance criterion (30 s) with room to
// spare, and a burst of edits is one request.
func TestPushFollowsChanges(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	p := NewPusher(func() *store.Store { return desktop.store }, desktop.backend)
	// Wide enough that a loaded machine under -race can't split the burst.
	p.debounce, p.maxWait = 500*time.Millisecond, 2*time.Second
	desktop.store.OnQueued(p.Notify)
	// Not Start: its launch flush would race the saves and send the first.
	p.ctx = t.Context()
	t.Cleanup(p.Stop)

	for i, name := range []string{"Dune", "Arrival", "Sicario"} {
		check(t, desktop.store.SaveLibraryItem(desktop.profile.ID, store.LibraryItem{
			ContentID: "tt" + string(rune('1'+i)), ContentType: "movie", Name: name, AddedAt: int64(1000 + i),
		}))
	}
	_, err := desktop.store.SaveProgress(desktop.profile.ID, episode)
	check(t, err)

	deadline := time.Now().Add(5 * time.Second)
	for len(pending(t, desktop)) > 0 {
		if time.Now().After(deadline) {
			t.Fatalf("still queued after 5 s: %+v", pending(t, desktop))
		}
		time.Sleep(5 * time.Millisecond)
	}
	if rows(server, nuviotest.Library) != 3 || rows(server, nuviotest.Progress) != 1 {
		t.Fatalf("server has %d library rows, %d progress rows", rows(server, nuviotest.Library), rows(server, nuviotest.Progress))
	}
	if n := server.Pushes("sync_push_library_items"); n != 1 {
		t.Fatalf("three saves made %d library pushes, want 1", n)
	}

	// And the phone sees it after its next pull.
	phone := newDevice(t, server)
	puller, _, _ := phone.puller()
	if _, err := puller.Pull(t.Context()); err != nil {
		t.Fatal(err)
	}
	if got, _ := phone.store.ContinueWatching(phone.profile.ID); len(got) != 1 || got[0].Position != episode.Position {
		t.Fatalf("the other device's continue watching = %+v", got)
	}
}

// A player saves its position every few seconds. The loop pushes it once, then
// at most every 30 s, and the last position goes out when asked.
func TestProgressPushedEvery30Seconds(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	p, clock := desktop.pusher()

	save := func(position, lastWatched int64) {
		t.Helper()
		e := episode
		e.Position, e.LastWatched = position, lastWatched
		_, err := desktop.store.SaveProgress(desktop.profile.ID, e)
		check(t, err)
	}
	pushes := func() int { return server.Pushes("sync_push_watch_progress") }

	save(100_000, 1_000_000)
	check(t, p.flush(t.Context(), auto))
	if pushes() != 1 {
		t.Fatalf("first save: %d pushes", pushes())
	}

	// Playing on: saved every 10 s, nothing sent until 30 s are up, and then
	// the latest position, outside the server's throttle.
	for i := int64(1); i <= 2; i++ {
		*clock = clock.Add(10 * time.Second)
		save(100_000+i*10_000, 1_000_000+i*10_000)
		check(t, p.flush(t.Context(), auto))
		if pushes() != 1 || len(pending(t, desktop)) != 1 {
			t.Fatalf("after %d s: %d pushes, %d queued", i*10, pushes(), len(pending(t, desktop)))
		}
	}
	*clock = clock.Add(10 * time.Second)
	save(130_000, 1_030_000)
	check(t, p.flush(t.Context(), auto))
	if pushes() != 2 || len(pending(t, desktop)) != 0 {
		t.Fatalf("after 30 s: %d pushes, %d queued", pushes(), len(pending(t, desktop)))
	}
	if got := server.Rows(email, 1, nuviotest.Progress)[0]["position"]; got != float64(130_000) {
		t.Fatalf("server position = %v", got)
	}
	if server.DroppedProgress() != 0 {
		t.Fatalf("the server dropped %d entries", server.DroppedProgress())
	}

	// Pause: the position goes out at once, not after the interval.
	*clock = clock.Add(time.Second)
	save(131_000, 1_031_000)
	check(t, p.flush(t.Context(), auto))
	if pushes() != 2 {
		t.Fatal("auto flush ignored the progress interval")
	}
	check(t, p.Flush(t.Context()))
	if pushes() != 3 || len(pending(t, desktop)) != 0 {
		t.Fatalf("after a flush: %d pushes, %d queued", pushes(), len(pending(t, desktop)))
	}
}

// Library and watched changes aren't held to the progress interval.
func TestOtherChangesGoAtOnce(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	p, _ := desktop.pusher()

	check(t, desktop.store.SaveLibraryItem(desktop.profile.ID, dune))
	check(t, p.flush(t.Context(), auto))
	check(t, desktop.store.RemoveLibraryItem(desktop.profile.ID, dune.ContentID, dune.ContentType))
	check(t, p.flush(t.Context(), auto))
	if n := server.Pushes("sync_push_library_items") + server.Pushes("sync_delete_library_items"); n != 2 {
		t.Fatalf("%d library calls, want a push and a delete", n)
	}
	if rows(server, nuviotest.Library) != 0 {
		t.Fatal("the delete didn't reach the server")
	}
}

// A push that fails stays queued, is tried again after a growing backoff, and
// goes out once the backend is back, even after a restart.
func TestFailedPushIsRetriedWithBackoff(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	p, clock := desktop.pusher()
	p.backoffMin, p.backoffMax = 10*time.Second, 40*time.Second

	check(t, desktop.store.SaveLibraryItem(desktop.profile.ID, dune))
	desktop.sessions.err = nuvio.ErrUnreachable
	err := p.flush(t.Context(), auto)
	if !errors.Is(err, nuvio.ErrUnreachable) || !backend.Offline(err) {
		t.Fatalf("flush offline = %v", err)
	}
	queued := pending(t, desktop)
	if len(queued) != 1 || queued[0].Attempts != 1 || queued[0].LastError == "" {
		t.Fatalf("queued = %+v", queued)
	}

	// Inside the backoff an automatic flush doesn't try.
	calls := desktop.sessions.calls
	*clock = clock.Add(5 * time.Second)
	check(t, p.flush(t.Context(), auto))
	if desktop.sessions.calls != calls {
		t.Fatal("tried again inside the backoff")
	}

	// After it, it tries and fails again, and waits longer.
	*clock = clock.Add(10 * time.Second)
	if err := p.flush(t.Context(), auto); !errors.Is(err, nuvio.ErrUnreachable) {
		t.Fatalf("second try = %v", err)
	}
	if wait := p.retryAt.Sub(*clock); wait < 16*time.Second || wait > 20*time.Second {
		t.Fatalf("second backoff = %v, want 20 s less up to a fifth", wait)
	}
	for range 5 {
		*clock = p.retryAt
		p.flush(t.Context(), auto)
	}
	if wait := p.retryAt.Sub(*clock); wait > 40*time.Second {
		t.Fatalf("backoff = %v, want at most the cap", wait)
	}
	if got := pending(t, desktop); len(got) != 1 || got[0].Attempts < 7 {
		t.Fatalf("queued = %+v", got)
	}

	// The app restarts: the outbox is on disk.
	check(t, desktop.store.Close())
	reopened, err := store.Open(desktop.path)
	check(t, err)
	t.Cleanup(func() { reopened.Close() })
	desktop.store = reopened
	if len(pending(t, desktop)) != 1 {
		t.Fatal("the queued push didn't survive a restart")
	}

	// A launch ignores the backoff; the backend is back.
	desktop.sessions.err = nil
	q, _ := desktop.pusher()
	check(t, q.flush(t.Context(), kick))
	if len(pending(t, desktop)) != 0 || rows(server, nuviotest.Library) != 1 {
		t.Fatalf("queued %+v, server has %d rows", pending(t, desktop), rows(server, nuviotest.Library))
	}
	if p.failures == 0 {
		t.Fatal("the failures weren't counted")
	}
	check(t, p.flush(t.Context(), force))
	if p.failures != 0 {
		t.Fatal("a success didn't end the backoff")
	}
}

// A signed-out session or a rate limit also leaves the push queued.
func TestPushKeepsWhatItCouldNotSend(t *testing.T) {
	for _, cause := range []error{nuvio.ErrSignedOut, nuvio.ErrRateLimited, nuvio.ErrUnavailable} {
		server := nuviotest.NewServer(t)
		desktop := newDevice(t, server)
		p, _ := desktop.pusher()
		check(t, desktop.store.SaveLibraryItem(desktop.profile.ID, dune))
		desktop.sessions.err = cause
		if err := p.Flush(t.Context()); !errors.Is(err, cause) {
			t.Fatalf("flush = %v, want %v", err, cause)
		}
		if len(pending(t, desktop)) != 1 {
			t.Fatalf("%v: the push was lost", cause)
		}
	}
}

// The server makes the watched item itself at 90 %, so the loop doesn't send
// its own on top. It waits out the server's interval, pulls, and finds the
// item there.
func TestWatchedItemIsNotPushedTwice(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	p, clock := desktop.pusher()
	puller, _, _ := desktop.puller()
	p.refresh = func(ctx context.Context) { puller.Pull(ctx) }

	done := episode
	done.Position, done.Duration = 2_900_000, 3_000_000
	_, err := desktop.store.SaveProgress(desktop.profile.ID, done)
	check(t, err)
	check(t, desktop.store.MarkWatched(desktop.profile.ID, store.WatchedItem{
		ContentID: done.ContentID, ContentType: "series", Season: done.Season, Episode: done.Episode, WatchedAt: done.LastWatched,
	}))
	check(t, p.flush(t.Context(), auto))

	if rows(server, nuviotest.Watched) != 1 {
		t.Fatal("the server didn't make the watched item")
	}
	if n := server.Pushes("sync_push_watched_items"); n != 0 {
		t.Fatalf("sent %d watched pushes alongside the progress", n)
	}
	if got := pending(t, desktop); len(got) != 1 || got[0].Surface != store.SurfaceWatched {
		t.Fatalf("queued = %+v, want the watched push held back", got)
	}
	if p.wakeAt.IsZero() {
		t.Fatal("nothing is set to wake the loop when the grace ends")
	}

	// Within the grace it stays held; after it, the pull finds the server's
	// copy and the push is dropped.
	*clock = clock.Add(p.grace / 2)
	check(t, p.flush(t.Context(), auto))
	if len(pending(t, desktop)) != 1 {
		t.Fatal("sent inside the grace")
	}
	*clock = clock.Add(p.grace)
	check(t, p.flush(t.Context(), auto))
	if n := server.Pushes("sync_push_watched_items"); n != 0 || len(pending(t, desktop)) != 0 {
		t.Fatalf("%d watched pushes, %+v queued", n, pending(t, desktop))
	}
	if got, _ := desktop.store.Watched(desktop.profile.ID); len(got) != 1 {
		t.Fatalf("watched = %+v", got)
	}
}

// Held watched pushes go out after the grace if no pull has found the item,
// and a film with no finished progress behind it goes at once.
func TestWatchedItemIsPushedAfterTheGrace(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	p, clock := desktop.pusher()

	done := episode
	done.Position, done.Duration = 2_900_000, 3_000_000
	_, err := desktop.store.SaveProgress(desktop.profile.ID, done)
	check(t, err)
	check(t, p.flush(t.Context(), auto))

	check(t, desktop.store.MarkWatched(desktop.profile.ID, store.WatchedItem{
		ContentID: done.ContentID, ContentType: "series", Season: done.Season, Episode: done.Episode, WatchedAt: 2,
	}))
	check(t, desktop.store.MarkWatched(desktop.profile.ID, store.WatchedItem{ContentID: "tt0000001", ContentType: "movie", WatchedAt: 1}))
	check(t, p.flush(t.Context(), auto))
	if n := server.Pushes("sync_push_watched_items"); n != 1 || len(pending(t, desktop)) != 1 {
		t.Fatalf("%d watched pushes, %d queued: want the film sent and the episode held", n, len(pending(t, desktop)))
	}

	*clock = clock.Add(p.grace)
	check(t, p.flush(t.Context(), auto))
	if n := server.Pushes("sync_push_watched_items"); n != 2 || len(pending(t, desktop)) != 0 {
		t.Fatalf("%d watched pushes, %d queued after the grace", n, len(pending(t, desktop)))
	}
}

// The player's flush (a pause, seek or stop past 90 %, #64) and the exit's
// send the finished progress at once, past the progress interval, but the
// watched item still waits for the server's own copy.
func TestFlushProgressHoldsWatchedPushes(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	p, clock := desktop.pusher()

	playing := episode
	playing.Position, playing.Duration = 2_600_000, 3_000_000
	_, err := desktop.store.SaveProgress(desktop.profile.ID, playing)
	check(t, err)
	check(t, p.flush(t.Context(), auto))

	*clock = clock.Add(5 * time.Second)
	done := playing
	done.Position, done.LastWatched = 2_900_000, playing.LastWatched+5_000
	_, err = desktop.store.SaveProgress(desktop.profile.ID, done)
	check(t, err)
	check(t, desktop.store.MarkWatched(desktop.profile.ID, store.WatchedItem{
		ContentID: done.ContentID, ContentType: "series", Season: done.Season, Episode: done.Episode, WatchedAt: 2,
	}))
	check(t, p.FlushProgress(t.Context()))
	if n := server.Pushes("sync_push_watch_progress"); n != 2 {
		t.Fatalf("%d progress pushes, want the finished position sent inside the interval", n)
	}
	if n := server.Pushes("sync_push_watched_items"); n != 0 || rows(server, nuviotest.Watched) != 1 {
		t.Fatalf("%d watched pushes, %d server rows: want the server's own item only", n, rows(server, nuviotest.Watched))
	}
	if got := pending(t, desktop); len(got) != 1 || got[0].Surface != store.SurfaceWatched {
		t.Fatalf("queued = %+v, want the watched push held back", got)
	}
}

// A forced flush (sign-out) doesn't wait for the grace.
func TestFlushSendsHeldWatchedPushes(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	p, _ := desktop.pusher()

	done := episode
	done.Position, done.Duration = 2_900_000, 3_000_000
	_, err := desktop.store.SaveProgress(desktop.profile.ID, done)
	check(t, err)
	check(t, desktop.store.MarkWatched(desktop.profile.ID, store.WatchedItem{
		ContentID: done.ContentID, ContentType: "series", Season: done.Season, Episode: done.Episode, WatchedAt: 2,
	}))
	check(t, p.flush(t.Context(), auto))
	if len(pending(t, desktop)) != 1 {
		t.Fatal("the watched push wasn't held")
	}
	check(t, p.Flush(t.Context()))
	if len(pending(t, desktop)) != 0 {
		t.Fatalf("queued = %+v", pending(t, desktop))
	}
}

// onOwnServer is newDevice with the fake as a custom server (#34), the only
// kind the home layout and collections are pushed to.
func onOwnServer(t *testing.T, server *nuviotest.Server) *device {
	t.Helper()
	d := newDevice(t, server)
	client := nuvio.New("https://nuvio.invalid", "1.2.3")
	client.UseServer(server.URL, "")
	d.backend.Client = client
	return d
}

// Home layout and collections never go to the official backend (#35): on
// Nuvio's server a queued push is dropped unsent, with the rest still sent;
// on a custom server it goes out like any other.
func TestHomeIsPushedToOwnServerOnly(t *testing.T) {
	if backend.Syncs("settings") {
		t.Error("Syncs(settings) = true")
	}
	layout := store.HomeLayout{Rows: []store.HomeRow{{AddonID: "org.cinemeta", Type: "movie", CatalogID: "top", Enabled: true}}}
	collections := []byte(`[{"id":"c1","title":"Streaming","folders":[]}]`)

	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	check(t, desktop.store.SetHomeLayout(desktop.profile.ID, layout))
	check(t, desktop.store.SetCollections(desktop.profile.ID, collections))
	check(t, desktop.store.SaveLibraryItem(desktop.profile.ID, dune))
	p, _ := desktop.pusher()
	check(t, p.Flush(t.Context()))
	if len(pending(t, desktop)) != 0 {
		t.Fatalf("still queued: %+v", pending(t, desktop))
	}
	for _, rpc := range []string{"sync_push_home_catalog_settings", "sync_push_collections"} {
		if n := server.Pushes(rpc); n != 0 {
			t.Errorf("%s reached Nuvio's server %d times", rpc, n)
		}
	}
	if server.HomeLayout(email, 1, "home_catalog_shared") != nil || server.SyncedCollections(email, 1) != nil {
		t.Error("the layout or collections reached Nuvio's server")
	}
	if rows(server, nuviotest.Library) != 1 {
		t.Error("the library push beside them wasn't sent")
	}

	own := nuviotest.NewServer(t)
	selfHosted := onOwnServer(t, own)
	check(t, selfHosted.store.SetHomeLayout(selfHosted.profile.ID, layout))
	check(t, selfHosted.store.SetCollections(selfHosted.profile.ID, collections))
	p, _ = selfHosted.pusher()
	check(t, p.Flush(t.Context()))
	if len(pending(t, selfHosted)) != 0 {
		t.Fatalf("still queued: %+v", pending(t, selfHosted))
	}
	items, _ := own.HomeLayout(email, 1, "home_catalog_shared")["items"].([]any)
	if len(items) != 1 || len(own.SyncedCollections(email, 1)) != 1 {
		t.Fatalf("own server has layout %v, collections %v", own.HomeLayout(email, 1, "home_catalog_shared"), own.SyncedCollections(email, 1))
	}

	// Another device on the same server pulls them in.
	phone := onOwnServer(t, own)
	puller, _, emitted := phone.puller()
	if _, err := puller.Pull(t.Context()); err != nil {
		t.Fatal(err)
	}
	got, err := phone.store.HomeLayout(phone.profile.ID)
	check(t, err)
	if got == nil || len(got.Rows) != 1 || got.Rows[0].CatalogID != "top" {
		t.Fatalf("the phone's layout = %+v", got)
	}
	if c, _ := phone.store.Collections(phone.profile.ID); len(c) != 1 || c[0].Title != "Streaming" {
		t.Fatalf("the phone's collections = %+v", c)
	}
	if len(*emitted) != 1 || !slices.Contains((*emitted)[0].Surfaces, store.SurfaceHomeLayout) || !slices.Contains((*emitted)[0].Surfaces, store.SurfaceCollections) {
		t.Fatalf("emitted %+v", *emitted)
	}
}

// A guest queues nothing, so the loop never wakes for it and never asks
// Nuvio anything.
func TestGuestIsNeverPushed(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	guest, err := desktop.store.CreateProfile(store.Profile{Name: "Guest"})
	check(t, err)
	woken := 0
	desktop.store.OnQueued(func(uint64) { woken++ })

	check(t, desktop.store.SaveLibraryItem(guest.ID, dune))
	_, err = desktop.store.SaveProgress(guest.ID, episode)
	check(t, err)
	if woken != 0 {
		t.Fatalf("the guest's changes woke the push loop %d times", woken)
	}
	p, _ := desktop.pusher()
	before := len(server.Calls())
	check(t, p.Flush(t.Context()))
	if len(server.Calls()) != before || rows(server, nuviotest.Library) != 0 {
		t.Fatal("the guest's data reached Nuvio")
	}
}

// Nothing queued means nothing sent, and a change by a pull isn't pushed.
func TestPullQueuesNoPush(t *testing.T) {
	server := nuviotest.NewServer(t)
	phone, desktop := newDevice(t, server), newDevice(t, server)
	check(t, phone.store.SaveLibraryItem(phone.profile.ID, dune))
	phone.push(t)

	woken := 0
	desktop.store.OnQueued(func(uint64) { woken++ })
	puller, _, _ := desktop.puller()
	if _, err := puller.Pull(t.Context()); err != nil {
		t.Fatal(err)
	}
	if woken != 0 {
		t.Fatalf("a pull woke the push loop %d times", woken)
	}
	p, _ := desktop.pusher()
	before := len(server.Calls())
	check(t, p.Flush(t.Context()))
	if len(server.Calls()) != before {
		t.Fatalf("flushing an empty outbox made requests: %v", server.Calls()[before:])
	}
}
