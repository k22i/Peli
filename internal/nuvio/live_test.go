package nuvio

import (
	"context"
	"os"
	"testing"
	"time"
)

// TestLive signs in to a real backend, reads the profiles and signs out
// again, leaving nothing behind: the per-release live
// check of ADR-0004. It runs only with SINAG_NUVIO_LIVE=1 and an account in
// NUVIO_EMAIL and NUVIO_PASSWORD (NUVIO_URL defaults to api.nuvio.tv). It
// logs timings and counts, never the account's data.
func TestLive(t *testing.T) {
	if os.Getenv("SINAG_NUVIO_LIVE") != "1" {
		t.Skip("set SINAG_NUVIO_LIVE=1, NUVIO_EMAIL and NUVIO_PASSWORD to sign in to a live backend")
	}
	url := os.Getenv("NUVIO_URL")
	if url == "" {
		url = DefaultURL
	}
	c := New(url, "0.0.0-live-test")

	start := time.Now()
	if _, err := c.publishableKey(t.Context()); err != nil {
		t.Fatal(err)
	}
	t.Logf("discovery: %v", time.Since(start).Round(time.Millisecond))

	if _, err := c.SignInWithPassword(t.Context(), os.Getenv("NUVIO_EMAIL"), "not the password"); err != ErrInvalidCredentials {
		t.Fatalf("wrong password: err = %v, want ErrInvalidCredentials", err)
	}

	start = time.Now()
	s, err := c.SignInWithPassword(t.Context(), os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD"))
	if err != nil {
		t.Fatal(err)
	}
	signIn := time.Since(start)
	// Not t.Context(): it is cancelled before cleanups run.
	t.Cleanup(func() {
		if err := c.SignOut(context.Background(), s); err != nil {
			t.Errorf("sign out: %v", err)
		}
	})
	t.Logf("sign in: %v, session lasts %v", signIn.Round(time.Millisecond), time.Until(s.ExpiresAt).Round(time.Hour))

	start = time.Now()
	profiles, err := c.Profiles(t.Context(), s)
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("profiles: %v, %d profile(s); sign-in to profiles: %v",
		time.Since(start).Round(time.Millisecond), len(profiles), (signIn + time.Since(start)).Round(time.Millisecond))
	for _, p := range profiles {
		if p.Index < 1 || p.Index > 6 || p.Name == "" {
			t.Errorf("profile with index %d and a name of %d bytes", p.Index, len(p.Name))
		}
	}
}
