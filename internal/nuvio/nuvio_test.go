package nuvio

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/k22i/Sinag/internal/nuvio/nuviotest"
)

func newTestClient(url string) *Client {
	c := New(url, "1.2.3")
	c.sleep = func(context.Context, time.Duration) error { return nil }
	return c
}

func TestSignInWithPassword(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)

	before := time.Now()
	s, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	if s.AccessToken != nuviotest.AccessToken || s.RefreshToken != nuviotest.RefreshToken {
		t.Fatalf("session = %+v", s)
	}
	if got := s.ExpiresAt.Sub(before); got < 7*24*time.Hour || got > 7*24*time.Hour+time.Minute {
		t.Fatalf("expires in %v, want 7 days", got)
	}
	if calls := b.Calls(); len(calls) != 1 || calls[0] != "POST /auth/v1/token?grant_type=password" {
		t.Fatalf("calls = %q", calls)
	}
	if body := b.Body("/auth/v1/token"); body["email"] != "me@example.com" {
		t.Fatalf("body = %v", body)
	}
	if got := b.UserAgents()[0]; got != "Sinag/1.2.3 (+https://github.com/k22i/Sinag)" {
		t.Fatalf("User-Agent = %q", got)
	}
}

func TestSignInWithWrongPassword(t *testing.T) {
	b := nuviotest.NewServer(t)
	_, err := newTestClient(b.URL).SignInWithPassword(t.Context(), "me@example.com", "wrong")
	if !errors.Is(err, ErrInvalidCredentials) {
		t.Fatalf("err = %v, want ErrInvalidCredentials", err)
	}
	if n := len(b.Calls()); n != 1 {
		t.Fatalf("%d calls, want 1: a wrong password isn't retried", n)
	}
}

func TestRateLimitBacksOffThenSucceeds(t *testing.T) {
	b := nuviotest.NewServer(t)
	b.Limited.Store(2)
	c := newTestClient(b.URL)
	var waits []time.Duration
	c.sleep = func(_ context.Context, d time.Duration) error {
		waits = append(waits, d)
		return nil
	}

	if _, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password); err != nil {
		t.Fatal(err)
	}
	if len(waits) != 2 {
		t.Fatalf("waited %d times, want 2", len(waits))
	}
	// Full jitter: each wait is below its doubling cap.
	for i, wait := range waits {
		if limit := c.backoff << i; wait < 0 || wait >= limit {
			t.Fatalf("wait %d = %v, want under %v", i, wait, limit)
		}
	}
}

func TestRateLimitGivesUp(t *testing.T) {
	b := nuviotest.NewServer(t)
	b.Limited.Store(100)
	_, err := newTestClient(b.URL).SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if !errors.Is(err, ErrRateLimited) {
		t.Fatalf("err = %v, want ErrRateLimited", err)
	}
	if n := len(b.Calls()); n != 3 {
		t.Fatalf("%d calls, want 3 (two retries)", n)
	}
}

func TestRateLimitBackoffStopsWithContext(t *testing.T) {
	b := nuviotest.NewServer(t)
	b.Limited.Store(100)
	c := New(b.URL, "1.2.3")
	if _, err := c.publishableKey(t.Context()); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	c.sleep = func(ctx context.Context, d time.Duration) error {
		cancel()
		return sleep(ctx, time.Hour)
	}
	if _, err := c.SignInWithPassword(ctx, "me@example.com", nuviotest.Password); !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

func TestUnreachable(t *testing.T) {
	b := nuviotest.NewServer(t)
	url := b.URL
	b.Close()
	_, err := newTestClient(url).SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if !errors.Is(err, ErrUnreachable) {
		t.Fatalf("err = %v, want ErrUnreachable", err)
	}
}

func TestServerError(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusBadGateway)
		w.Write([]byte("<html>502 Bad Gateway</html>"))
	}))
	defer s.Close()
	_, err := newTestClient(s.URL).SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if !errors.Is(err, ErrUnavailable) {
		t.Fatalf("err = %v, want ErrUnavailable", err)
	}
}

func TestNotANuvioBackend(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Write([]byte(`{"service":"something-else"}`))
	}))
	defer s.Close()
	_, err := newTestClient(s.URL).SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err == nil || !strings.Contains(err.Error(), "not a Nuvio backend") {
		t.Fatalf("err = %v", err)
	}
}

func TestProfilesAndSignOut(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)
	s, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}

	profiles, err := c.Profiles(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	if len(profiles) != 2 || profiles[0].Index != 1 || profiles[0].Name != "Kevin" ||
		profiles[1].Index != 3 || !profiles[1].PinEnabled || *profiles[1].AvatarURL != "https://img/a7.png" {
		t.Fatalf("profiles = %+v", profiles)
	}

	if err := c.SignOut(t.Context(), s); err != nil {
		t.Fatal(err)
	}
}

func TestSignedOut(t *testing.T) {
	b := nuviotest.NewServer(t)
	_, err := newTestClient(b.URL).Profiles(t.Context(), Session{AccessToken: "revoked"})
	if !errors.Is(err, ErrSignedOut) {
		t.Fatalf("err = %v, want ErrSignedOut", err)
	}
}

func TestDiscoveryIsReadOnce(t *testing.T) {
	var discoveries atomic.Int32
	b := nuviotest.NewServer(t)
	inner := b.Config.Handler
	b.Config.Handler = http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/nuvio" {
			discoveries.Add(1)
		}
		inner.ServeHTTP(w, r)
	})
	c := newTestClient(b.URL)
	for range 3 {
		c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	}
	if n := discoveries.Load(); n != 1 {
		t.Fatalf("read the discovery document %d times, want 1", n)
	}
}
