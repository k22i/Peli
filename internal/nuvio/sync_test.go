package nuvio

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"testing"
	"time"

	"github.com/k22i/Peli/internal/nuvio/nuviotest"
)

func signedIn(t *testing.T) (*nuviotest.Server, *Client, Session) {
	t.Helper()
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)
	s, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	return b, c, s
}

func ptr[T any](v T) *T { return &v }

func fail(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

func TestLibrarySync(t *testing.T) {
	b, c, s := signedIn(t)
	ctx := t.Context()
	dune := LibraryRow{ContentID: "tt1160419", ContentType: "movie", Name: "Dune", PosterShape: "POSTER",
		IMDBRating: ptr(8.0), Genres: []string{"Sci-Fi"}, AddedAt: 2000}
	fail(t, c.PushLibrary(ctx, s, 1, []LibraryRow{dune, {ContentID: "tt11280740", ContentType: "series", Name: "Severance", AddedAt: 3000}}))

	events, err := c.LibraryDelta(ctx, s, 1, 0)
	fail(t, err)
	if len(events) != 2 || events[0].Operation != OpUpsert || !reflect.DeepEqual(events[0].LibraryRow, dune) {
		t.Fatalf("events = %+v", events)
	}
	if events[1].EventID <= events[0].EventID {
		t.Fatalf("event IDs %d, %d don't ascend", events[0].EventID, events[1].EventID)
	}

	// Profiles are separate, and a delete event carries the row as it was.
	other, err := c.LibraryDelta(ctx, s, 2, 0)
	fail(t, err)
	if len(other) != 0 {
		t.Fatalf("profile 2 has %+v", other)
	}
	fail(t, c.DeleteLibrary(ctx, s, 1, []LibraryKey{{ContentID: dune.ContentID, ContentType: dune.ContentType}}))
	events, err = c.LibraryDelta(ctx, s, 1, events[1].EventID)
	fail(t, err)
	if len(events) != 1 || events[0].Operation != OpDelete || !reflect.DeepEqual(events[0].LibraryRow, dune) {
		t.Fatalf("after delete: %+v", events)
	}
	if rows := b.Rows("me@example.com", 1, nuviotest.Library); len(rows) != 1 {
		t.Fatalf("server has %v", rows)
	}
}

// A page shorter than DeltaLimit is the last one; the next page starts at the
// last event of this one.
func TestDeltaPaging(t *testing.T) {
	_, c, s := signedIn(t)
	var items []LibraryRow
	for i := range DeltaLimit + 5 {
		items = append(items, LibraryRow{ContentID: fmt.Sprintf("tt%07d", i), ContentType: "movie", Name: "x"})
	}
	fail(t, c.PushLibrary(t.Context(), s, 1, items))
	first, err := c.LibraryDelta(t.Context(), s, 1, 0)
	fail(t, err)
	rest, err := c.LibraryDelta(t.Context(), s, 1, first[len(first)-1].EventID)
	fail(t, err)
	if len(first) != DeltaLimit || len(rest) != 5 {
		t.Fatalf("pages of %d and %d, want %d and 5", len(first), len(rest), DeltaLimit)
	}
}

func TestProgressSync(t *testing.T) {
	b, c, s := signedIn(t)
	ctx := t.Context()
	film := ProgressRow{ContentID: "tt1254207", ContentType: "movie", VideoID: "tt1254207", Position: 600_000, Duration: 6_000_000, LastWatched: 1_000_000}
	episode := ProgressRow{ContentID: "tt11280740", ContentType: "series", VideoID: "tt11280740:1:2", Season: ptr(1), Episode: ptr(2),
		Position: 100_000, Duration: 3_000_000, LastWatched: 1_000_000}
	fail(t, c.PushProgress(ctx, s, 1, []ProgressRow{film, episode}))

	events, err := c.ProgressDelta(ctx, s, 1, 0)
	fail(t, err)
	if len(events) != 2 || events[0].ProgressKey != "tt1254207" || events[1].ProgressKey != "tt11280740_s1e2" {
		t.Fatalf("events = %+v", events)
	}

	// Inside the thresholds the server answers 200 and keeps the old row.
	nudged := film
	nudged.Position += 10_000
	nudged.LastWatched += 10_000
	fail(t, c.PushProgress(ctx, s, 1, []ProgressRow{nudged}))
	if b.DroppedProgress() != 1 {
		t.Fatalf("dropped %d, want the push inside 15 s / 30 s to be dropped", b.DroppedProgress())
	}
	nudged.Position += 20_000
	fail(t, c.PushProgress(ctx, s, 1, []ProgressRow{nudged}))
	if b.DroppedProgress() != 1 {
		t.Fatal("a push that moved 30 s was dropped")
	}

	// Finishing a film adds a watched item on the server.
	done := film
	done.Position, done.LastWatched = 5_500_000, 9_000_000
	fail(t, c.PushProgress(ctx, s, 1, []ProgressRow{done}))
	watched, err := c.WatchedDelta(ctx, s, 1, 0)
	fail(t, err)
	if len(watched) != 1 || watched[0].ContentID != film.ContentID || watched[0].WatchedAt != 9_000_000 {
		t.Fatalf("watched = %+v", watched)
	}

	fail(t, c.DeleteProgress(ctx, s, 1, []string{"tt11280740_s1e2"}))
	if rows := b.Rows("me@example.com", 1, nuviotest.Progress); len(rows) != 1 {
		t.Fatalf("server has %v", rows)
	}
}

func TestWatchedSync(t *testing.T) {
	b, c, s := signedIn(t)
	ctx := t.Context()
	fail(t, c.PushWatched(ctx, s, 1, []WatchedRow{
		{ContentID: "tt1160419", ContentType: "movie", Title: "Dune", WatchedAt: 5},
		{ContentID: "tt11280740", ContentType: "series", Season: ptr(1), Episode: ptr(2), WatchedAt: 6},
	}))
	events, err := c.WatchedDelta(ctx, s, 1, 0)
	fail(t, err)
	if len(events) != 2 || events[1].Season == nil || *events[1].Season != 1 || events[1].WatchedAt != 6 {
		t.Fatalf("events = %+v", events)
	}
	fail(t, c.DeleteWatched(ctx, s, 1, []WatchedKey{{ContentID: "tt11280740", Season: ptr(1), Episode: ptr(2)}}))
	if rows := b.Rows("me@example.com", 1, nuviotest.Watched); len(rows) != 1 {
		t.Fatalf("server has %v", rows)
	}
}

// An addons push replaces the list, in the order sent.
func TestAddonsSync(t *testing.T) {
	b, c, s := signedIn(t)
	ctx := t.Context()
	input := []AddonRow{
		{URL: "https://v3-cinemeta.strem.io/manifest.json", Name: "Cinemeta", Enabled: true},
		{URL: "https://opensubtitles-v3.strem.io/manifest.json", Name: "OpenSubtitles", Enabled: false},
	}
	fail(t, c.PushAddons(ctx, s, 1, input))
	if input[1].SortOrder != 0 {
		t.Fatal("PushAddons changed the caller's list")
	}
	got, err := c.Addons(ctx, s, 1)
	fail(t, err)
	want := []AddonRow{{input[0].URL, "Cinemeta", true, 0}, {input[1].URL, "OpenSubtitles", false, 1}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("addons = %+v, want %+v", got, want)
	}

	fail(t, c.PushAddons(ctx, s, 1, input[:1]))
	got, err = c.Addons(ctx, s, 1)
	fail(t, err)
	if len(got) != 1 {
		t.Fatalf("a shorter list left %+v", got)
	}
	if other, err := c.Addons(ctx, s, 2); err != nil || len(other) != 0 {
		t.Fatalf("profile 2 has %+v, %v", other, err)
	}
	if rows := b.SyncedAddons("me@example.com", 1); len(rows) != 1 {
		t.Fatalf("server has %v", rows)
	}
}

// A plugins push replaces the list of repositories, in the order sent, and
// keeps what the column holds: a name, a type, or neither (#57).
func TestPluginsSync(t *testing.T) {
	b, c, s := signedIn(t)
	ctx := t.Context()
	js := "NUVIO_JS"
	input := []PluginRow{
		{URL: "https://repo.example.com/manifest.json", Name: ptr("Example"), Enabled: true, RepoType: &js},
		{URL: "https://other.example.com/manifest.json", Enabled: false},
	}
	fail(t, c.PushPlugins(ctx, s, 1, input))
	if input[1].SortOrder != 0 {
		t.Fatal("PushPlugins changed the caller's list")
	}
	got, err := c.Plugins(ctx, s, 1)
	fail(t, err)
	want := []PluginRow{input[0], input[1]}
	want[1].SortOrder = 1
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("plugins = %+v, want %+v", got, want)
	}

	fail(t, c.PushPlugins(ctx, s, 1, input[:1]))
	got, err = c.Plugins(ctx, s, 1)
	fail(t, err)
	if len(got) != 1 {
		t.Fatalf("a shorter list left %+v", got)
	}
	if other, err := c.Plugins(ctx, s, 2); err != nil || len(other) != 0 {
		t.Fatalf("profile 2 has %+v, %v", other, err)
	}
	if rows := b.SyncedPlugins("me@example.com", 1); len(rows) != 1 {
		t.Fatalf("server has %v", rows)
	}
	body := b.Body("/rest/v1/rpc/sync_push_plugins")
	if body["p_origin_client_id"] != c.OriginClientID() || body["p_profile_id"] != 1.0 {
		t.Errorf("sync_push_plugins body = %v", body)
	}
}

// Every write carries p_origin_client_id and the profile index.
func TestWritesNameTheirOrigin(t *testing.T) {
	b, c, s := signedIn(t)
	ctx := t.Context()
	fail(t, c.PushLibrary(ctx, s, 3, nil))
	fail(t, c.DeleteWatched(ctx, s, 3, nil))
	fail(t, c.PushAddons(ctx, s, 3, nil))
	for _, rpc := range []string{"sync_push_library_items", "sync_delete_watched_items", "sync_push_addons"} {
		body := b.Body("/rest/v1/rpc/" + rpc)
		if body["p_origin_client_id"] != c.OriginClientID() || body["p_profile_id"] != 3.0 {
			t.Errorf("%s body = %v", rpc, body)
		}
	}
	if id := c.OriginClientID(); len(id) < 10 || id == New(b.URL, "1").OriginClientID() {
		t.Errorf("origin client ID %q isn't unique per client", id)
	}
	if got := b.UserAgents()[len(b.UserAgents())-1]; got != "Peli/1.2.3 (+https://github.com/k22i/Peli)" {
		t.Errorf("User-Agent = %q", got)
	}
}

func TestSyncErrors(t *testing.T) {
	_, c, s := signedIn(t)
	ctx := t.Context()
	if _, err := c.LibraryDelta(ctx, Session{AccessToken: "forged"}, 1, 0); !errors.Is(err, ErrSignedOut) {
		t.Errorf("no session: err = %v, want ErrSignedOut", err)
	}
	var api *APIError
	if err := c.PushLibrary(ctx, s, 7, nil); !errors.As(err, &api) || api.Code != "P0001" {
		t.Errorf("profile 7: err = %v, want P0001", err)
	}
}

func TestLimiterSpacesRequests(t *testing.T) {
	now := time.Unix(1000, 0)
	l := newLimiter(10, 3)
	l.now = func() time.Time { return now }
	var waits []time.Duration
	for range 5 {
		waits = append(waits, l.reserve())
	}
	// A burst of 3, then one every 100 ms.
	want := []time.Duration{0, 0, 0, 100 * time.Millisecond, 200 * time.Millisecond}
	if !reflect.DeepEqual(waits, want) {
		t.Fatalf("waits = %v, want %v", waits, want)
	}
	now = now.Add(time.Second)
	if wait := l.reserve(); wait != 0 {
		t.Fatalf("after a second: wait = %v", wait)
	}
}

func TestClientWaitsForTheLimiter(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := New(b.URL, "1.2.3")
	c.limiter = newLimiter(1, 1)
	var slept []time.Duration
	c.sleep = func(_ context.Context, d time.Duration) error { slept = append(slept, d); return nil }
	for range 2 {
		if _, err := c.AvatarCatalog(t.Context()); err != nil {
			t.Fatal(err)
		}
	}
	// Discovery and two catalog calls, a second apart each.
	if len(slept) != 2 || slept[0] < 900*time.Millisecond || slept[1] < 1900*time.Millisecond {
		t.Fatalf("slept %v, want waits of about 1 s and 2 s", slept)
	}
}
