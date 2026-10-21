package account

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/k22i/Sinag/internal/backend"
	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/nuvio/nuviotest"
	"github.com/k22i/Sinag/internal/store"
	"github.com/k22i/Sinag/internal/syncer"
)

// clock is a test clock that only moves when told to.
type clock struct {
	mu  sync.Mutex
	now time.Time
}

func (c *clock) Now() time.Time {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.now
}

func (c *clock) Add(d time.Duration) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.now = c.now.Add(d)
}

// signedIn returns a fixture that has signed in, on a test clock, with
// onEnded counting how often the session ended.
func signedIn(t *testing.T) (fixture, *clock, *atomic.Int32) {
	t.Helper()
	f := newFixture(t)
	if _, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password); err != nil {
		t.Fatal(err)
	}
	c, ended := watch(f.service)
	return f, c, ended
}

func watch(service *Service) (*clock, *atomic.Int32) {
	c := &clock{now: time.Now()}
	ended := &atomic.Int32{}
	service.session.now = c.Now
	service.session.onEnded = func() { ended.Add(1) }
	return c, ended
}

// relaunch is the app starting again on the same keychain and store.
func relaunch(t *testing.T, f fixture) fixture {
	t.Helper()
	f.service = NewService(nuvio.New(f.backend.URL, "1.2.3"), f.keychain, f.store)
	return f
}

func refreshes(f fixture) int {
	n := 0
	for _, call := range f.backend.Calls() {
		if strings.Contains(call, "grant_type=refresh_token") {
			n++
		}
	}
	return n
}

func status(t *testing.T, s *Service) Status {
	t.Helper()
	st, err := s.Status()
	if err != nil {
		t.Fatal(err)
	}
	return st
}

func TestRestoreNeedsNoNetwork(t *testing.T) {
	f, _, _ := signedIn(t)
	f.backend.Close()

	f = relaunch(t, f)
	if st := status(t, f.service); !st.SignedIn || st.SessionEnded {
		t.Fatalf("status = %+v, want signed in", st)
	}
	// Offline at launch: the refresh fails but the session is kept.
	err := f.service.session.refreshIfDue(t.Context())
	if !errors.Is(err, nuvio.ErrUnreachable) {
		t.Fatalf("refresh = %v, want ErrUnreachable", err)
	}
	if st := status(t, f.service); !st.SignedIn {
		t.Fatalf("status after an offline refresh = %+v", st)
	}
	if len(f.keychain.items) != 2 {
		t.Fatalf("keychain = %v", f.keychain.items)
	}
}

func TestRefreshAtLaunchThenHalfway(t *testing.T) {
	f, _, _ := signedIn(t)
	f = relaunch(t, f)
	c, _ := watch(f.service)
	ctx := t.Context()

	// Launch: refresh at once, and keep the rotated tokens.
	if err := f.service.session.refreshIfDue(ctx); err != nil {
		t.Fatal(err)
	}
	access, refresh := f.backend.Tokens()
	if f.keychain.items[KeyAccessToken] != access || f.keychain.items[KeyRefreshToken] != refresh {
		t.Fatalf("keychain = %v, want the refreshed tokens", f.keychain.items)
	}

	// Tokens last 7 days: the next refresh is 3.5 days on.
	c.Add(84*time.Hour - time.Minute)
	f.service.session.refreshIfDue(ctx)
	if n := refreshes(f); n != 1 {
		t.Fatalf("%d refreshes before halfway, want 1", n)
	}
	c.Add(2 * time.Minute)
	if err := f.service.session.refreshIfDue(ctx); err != nil {
		t.Fatal(err)
	}
	if n := refreshes(f); n != 2 {
		t.Fatalf("%d refreshes after halfway, want 2", n)
	}
}

func TestRefreshBacksOffWhileOffline(t *testing.T) {
	f, c, _ := signedIn(t)
	f.backend.Close()
	s := f.service.session
	ctx := t.Context()

	c.Add(85 * time.Hour)
	for i, wait := range []time.Duration{30 * time.Second, time.Minute, 2 * time.Minute, 4 * time.Minute} {
		if err := s.refreshIfDue(ctx); !errors.Is(err, nuvio.ErrUnreachable) {
			t.Fatalf("attempt %d: %v, want ErrUnreachable", i, err)
		}
		c.Add(wait - time.Second)
		if err := s.refreshIfDue(ctx); err != nil {
			t.Fatalf("attempt %d retried after %v, before its wait of %v", i, wait-time.Second, wait)
		}
		c.Add(time.Second)
	}
	// The wait stops growing at 15 minutes.
	for range 10 {
		s.refreshIfDue(ctx)
		c.Add(retryMax)
	}
	if s.refreshAt.Sub(c.Now()) > 0 {
		t.Fatalf("next retry in %v, want at most %v", s.refreshAt.Sub(c.Now())+retryMax, retryMax)
	}
}

func TestRevokedSessionKeepsLocalData(t *testing.T) {
	f, _, ended := signedIn(t)
	first, _ := f.store.CurrentProfile()
	db := store.Opened(f.store)
	if err := db.SaveLibraryItem(first.ID, store.LibraryItem{ContentID: "tt1160419", ContentType: "movie", Name: "Dune"}); err != nil {
		t.Fatal(err)
	}

	// Signed out everywhere from another device.
	f.backend.Revoke()
	f = relaunch(t, f)
	_, ended = watch(f.service)
	if err := f.service.session.refreshIfDue(t.Context()); !errors.Is(err, nuvio.ErrSignedOut) {
		t.Fatalf("refresh = %v, want ErrSignedOut", err)
	}
	if n := ended.Load(); n != 1 {
		t.Fatalf("onEnded called %d times, want 1", n)
	}
	if len(f.keychain.items) != 0 {
		t.Fatalf("keychain = %v, want the tokens gone", f.keychain.items)
	}
	if st := status(t, f.service); st.SignedIn || !st.SessionEnded {
		t.Fatalf("status = %+v, want session ended", st)
	}
	// Still ended after another launch: it's read from the store.
	if st := status(t, relaunch(t, f).service); !st.SessionEnded {
		t.Fatalf("status after relaunch = %+v", st)
	}

	// Signing in again picks up the same profiles and their data.
	again, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != first.ID {
		t.Fatalf("signed back in to %+v, want %+v", again, first)
	}
	if library, _ := db.Library(first.ID); len(library) != 1 {
		t.Fatalf("library = %+v", library)
	}
	if st := status(t, f.service); !st.SignedIn || st.SessionEnded {
		t.Fatalf("status = %+v, want signed in", st)
	}
}

func TestSignInToAnotherAccountAfterRevoked(t *testing.T) {
	f, _, _ := signedIn(t)
	mine, _ := f.store.CurrentProfile()
	f.backend.Revoke()
	f.service.session.refreshAt = time.Time{}
	f.service.session.refreshIfDue(t.Context())

	theirs, err := f.service.SignIn(t.Context(), "them@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	if theirs.ID == mine.ID {
		t.Fatalf("their profile reused mine: %+v", theirs)
	}
	profiles, _ := f.store.Profiles()
	if slices.ContainsFunc(profiles, func(p store.Profile) bool { return p.ID == mine.ID }) {
		t.Fatalf("my profile is still here: %+v", profiles)
	}
}

func TestSignOut(t *testing.T) {
	f := newFixture(t)
	guest, _ := f.store.CurrentProfile()
	if _, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password); err != nil {
		t.Fatal(err)
	}
	_, refresh := f.backend.Tokens()
	db := store.Opened(f.store)
	db.CacheSet("sinag-query-cache", []byte("{}"))

	if err := f.service.SignOut(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(f.keychain.items) != 0 {
		t.Fatalf("keychain = %v", f.keychain.items)
	}
	if calls := f.backend.Calls(); calls[len(calls)-1] != "POST /auth/v1/logout?scope=local" {
		t.Fatalf("calls = %q, want a logout last", calls)
	}
	// The backend session is over, not just forgotten here.
	if _, err := nuvio.New(f.backend.URL, "1.2.3").Refresh(t.Context(), refresh); !errors.Is(err, nuvio.ErrSignedOut) {
		t.Fatalf("refresh after sign-out = %v, want ErrSignedOut", err)
	}
	// The guest stays and is current; the account's profiles and the cache go.
	if profiles, _ := f.store.Profiles(); len(profiles) != 1 || profiles[0] != guest {
		t.Fatalf("profiles = %+v", profiles)
	}
	if current, _ := f.store.CurrentProfile(); current != guest {
		t.Fatalf("current = %+v", current)
	}
	if _, ok, _ := db.CacheGet("sinag-query-cache"); ok {
		t.Fatal("the cache is still there")
	}
	if st := status(t, f.service); st.SignedIn || st.SessionEnded {
		t.Fatalf("status = %+v, want signed out", st)
	}
	// Nothing left to refresh.
	if err := f.service.session.refreshIfDue(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestSignOutOffline(t *testing.T) {
	f, _, _ := signedIn(t)
	f.backend.Close()
	if err := f.service.SignOut(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(f.keychain.items) != 0 {
		t.Fatalf("keychain = %v", f.keychain.items)
	}
	if profiles, _ := f.store.Profiles(); len(profiles) != 0 {
		t.Fatalf("profiles = %+v", profiles)
	}
}

func TestDoRefreshesOnceForARefusedToken(t *testing.T) {
	f, _, _ := signedIn(t)
	f.backend.ExpireAccessTokens()

	// Many calls at once find the token refused; one refresh serves them all.
	var wg sync.WaitGroup
	errs := make([]error, 8)
	for i := range errs {
		wg.Go(func() {
			errs[i] = f.service.session.Do(t.Context(), func(s nuvio.Session) error {
				_, err := f.service.nuvio.Profiles(t.Context(), s)
				return err
			})
		})
	}
	wg.Wait()
	if err := errors.Join(errs...); err != nil {
		t.Fatal(err)
	}
	if n := refreshes(f); n != 1 {
		t.Fatalf("%d refreshes, want 1", n)
	}
}

func TestDoRefreshesAnExpiredToken(t *testing.T) {
	f, c, _ := signedIn(t)
	c.Add(7*24*time.Hour + time.Second)
	err := f.service.session.Do(t.Context(), func(nuvio.Session) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if n := refreshes(f); n != 1 {
		t.Fatalf("%d refreshes, want 1", n)
	}
}

func TestDoWhenSignedOut(t *testing.T) {
	f := newFixture(t)
	called := false
	err := f.service.session.Do(t.Context(), func(nuvio.Session) error { called = true; return nil })
	if !errors.Is(err, nuvio.ErrSignedOut) || called {
		t.Fatalf("Do = %v, called = %v; want ErrSignedOut and no call", err, called)
	}
}

func TestOneRefreshAtATime(t *testing.T) {
	f, _, _ := signedIn(t)
	f = relaunch(t, f)
	var wg sync.WaitGroup
	for range 8 {
		wg.Go(func() { f.service.session.refreshIfDue(t.Context()) })
	}
	wg.Wait()
	if n := refreshes(f); n != 1 {
		t.Fatalf("%d refreshes, want 1", n)
	}
}

func TestStatusWithoutKeychain(t *testing.T) {
	f := newFixture(t)
	f.keychain.unavailable = true
	if st := status(t, f.service); st.SignedIn || st.SessionEnded {
		t.Fatalf("status = %+v", st)
	}
}

func TestRunRefreshesAtLaunch(t *testing.T) {
	f, _, _ := signedIn(t)
	f = relaunch(t, f)
	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() { f.service.session.run(ctx, time.Millisecond); close(done) }()
	deadline := time.Now().Add(5 * time.Second)
	for refreshes(f) == 0 && time.Now().Before(deadline) {
		time.Sleep(time.Millisecond)
	}
	cancel()
	<-done
	if n := refreshes(f); n != 1 {
		t.Fatalf("%d refreshes, want 1", n)
	}
}

// Signing out sends what is queued first, while the session still works, so
// nothing the user did on this device is lost to it (#30).
func TestSignOutPushesWhatIsQueued(t *testing.T) {
	f, _, _ := signedIn(t)
	db := store.Opened(f.store)
	profile, err := f.store.CurrentProfile()
	if err != nil {
		t.Fatal(err)
	}
	pusher := syncer.NewPusher(func() *store.Store { return db },
		backend.Nuvio{Client: nuvio.New(f.backend.URL, "1.2.3"), Sessions: SessionOf(f.service)})
	FlushOnSignOut(f.service, pusher)

	item := store.LibraryItem{ContentID: "tt1160419", ContentType: "movie", Name: "Dune", AddedAt: 1}
	if err := db.SaveLibraryItem(profile.ID, item); err != nil {
		t.Fatal(err)
	}
	if err := f.service.SignOut(t.Context()); err != nil {
		t.Fatal(err)
	}
	if rows := f.backend.Rows("me@example.com", *profile.NuvioIndex, nuviotest.Library); len(rows) != 1 || rows[0]["content_id"] != item.ContentID {
		t.Fatalf("the server has %v after the sign-out", rows)
	}
	calls := f.backend.Calls()
	if calls[len(calls)-1] != "POST /auth/v1/logout?scope=local" {
		t.Fatalf("calls = %q, want the logout after the push", calls)
	}
}

// Offline, the push fails at once and the sign-out still goes ahead.
func TestSignOutOfflineStillSignsOutWithAFlusher(t *testing.T) {
	f, _, _ := signedIn(t)
	db := store.Opened(f.store)
	profile, _ := f.store.CurrentProfile()
	FlushOnSignOut(f.service, syncer.NewPusher(func() *store.Store { return db },
		backend.Nuvio{Client: nuvio.New(f.backend.URL, "1.2.3"), Sessions: SessionOf(f.service)}))
	if err := db.SaveLibraryItem(profile.ID, store.LibraryItem{ContentID: "tt1", ContentType: "movie", Name: "X"}); err != nil {
		t.Fatal(err)
	}
	f.backend.Close()
	if err := f.service.SignOut(t.Context()); err != nil {
		t.Fatal(err)
	}
	if len(f.keychain.items) != 0 {
		t.Fatalf("keychain = %v", f.keychain.items)
	}
}
