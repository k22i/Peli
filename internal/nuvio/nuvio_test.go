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
	if access, refresh := b.Tokens(); s.AccessToken != access || s.RefreshToken != refresh {
		t.Fatalf("session = %+v", s)
	}
	if s.UserID != nuviotest.UserID("me@example.com") {
		t.Fatalf("user = %q", s.UserID)
	}
	// The JWT's exp is in whole seconds.
	if got := s.ExpiresAt.Sub(before); got < 7*24*time.Hour-time.Second || got > 7*24*time.Hour+time.Minute {
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

func TestRefreshRotates(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)
	first, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}

	second, err := c.Refresh(t.Context(), first.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if second.RefreshToken == first.RefreshToken || second.AccessToken == first.AccessToken {
		t.Fatalf("refresh kept the old tokens: %+v", second)
	}
	if second.UserID != first.UserID || second.ExpiresAt.Before(first.ExpiresAt) {
		t.Fatalf("refreshed session = %+v, first %+v", second, first)
	}
	if body := b.Body("/auth/v1/token"); body["refresh_token"] != first.RefreshToken {
		t.Fatalf("body = %v", body)
	}

	// A second refresher with the same token gets the same new session, as
	// on live.
	again, err := c.Refresh(t.Context(), first.RefreshToken)
	if err != nil || again.RefreshToken != second.RefreshToken {
		t.Fatalf("reusing the last token: %v, same session %v", err, again.RefreshToken == second.RefreshToken)
	}

	// Once the newest has been used, the first is two behind and refused;
	// the newest still works.
	third, err := c.Refresh(t.Context(), second.RefreshToken)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := c.Refresh(t.Context(), first.RefreshToken); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("reusing an old token: err = %v, want ErrSignedOut", err)
	}
	if _, err := c.Refresh(t.Context(), third.RefreshToken); err != nil {
		t.Fatalf("the newest token after a reuse: %v", err)
	}
}

func TestRefreshAfterSignOut(t *testing.T) {
	b := nuviotest.NewServer(t)
	c := newTestClient(b.URL)
	s, err := c.SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	if err := c.SignOut(t.Context(), s); err != nil {
		t.Fatal(err)
	}
	if _, err := c.Refresh(t.Context(), s.RefreshToken); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("err = %v, want ErrSignedOut", err)
	}
}

func TestRefreshWithOldGoTrue(t *testing.T) {
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/.well-known/nuvio" {
			w.Write([]byte(`{"service":"nuvio","publishable_key":"k"}`))
			return
		}
		w.WriteHeader(http.StatusBadRequest)
		w.Write([]byte(`{"error":"invalid_grant","error_description":"Invalid Refresh Token"}`))
	}))
	defer s.Close()
	if _, err := newTestClient(s.URL).Refresh(t.Context(), "spent"); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("err = %v, want ErrSignedOut", err)
	}
}

func TestSessionFromTokens(t *testing.T) {
	b := nuviotest.NewServer(t)
	b.Lifetime.Store(3600)
	if _, err := newTestClient(b.URL).SignInWithPassword(t.Context(), "me@example.com", nuviotest.Password); err != nil {
		t.Fatal(err)
	}
	access, refresh := b.Tokens()

	s := SessionFromTokens(access, refresh)
	if s.UserID != nuviotest.UserID("me@example.com") || s.RefreshToken != refresh {
		t.Fatalf("session = %+v", s)
	}
	if left := time.Until(s.ExpiresAt); left < 59*time.Minute || left > time.Hour {
		t.Fatalf("expires in %v, want an hour", left)
	}

	for _, token := range []string{"", "opaque", "a.!!!.c", "a.bm90IGpzb24.c"} {
		if s := SessionFromTokens(token, refresh); !s.ExpiresAt.IsZero() || s.UserID != "" {
			t.Errorf("SessionFromTokens(%q) = %+v, want no claims", token, s)
		}
	}
}
