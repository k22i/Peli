package syncer

import (
	"testing"
	"time"

	"github.com/k22i/Peli/internal/nuvio/nuviotest"
	"github.com/k22i/Peli/internal/store"
)

// TestProgressReachesAnotherDeviceWithin30s is #33's integration test, and
// the epic's success metric: progress saved on one device is on another
// within 30 s. The desktop runs the push loop as it ships, debounce and all;
// the phone pulls every second, as close as a client gets to watching. It
// runs against the fake, and against a self-hosted Nuvio when
// PELI_CONTRACT_URL is set (ADR-0020).
func TestProgressReachesAnotherDeviceWithin30s(t *testing.T) {
	b := nuviotest.NewBackend(t)
	email, password := b.Account(t)
	desktop, phone := newDeviceAt(t, b.URL, email, password), newDeviceAt(t, b.URL, email, password)

	pusher := NewPusher(func() *store.Store { return desktop.store }, desktop.backend)
	desktop.store.OnQueued(pusher.Notify)
	pusher.Start(t.Context())
	t.Cleanup(pusher.Stop)
	puller := NewPuller(func() *store.Store { return phone.store }, phone.backend)
	if _, err := puller.PullNow(t.Context()); err != nil {
		t.Fatal(err)
	}

	start := time.Now()
	saved, err := desktop.store.SaveProgress(desktop.profile.ID, episode)
	check(t, err)
	for {
		if _, err := puller.PullNow(t.Context()); err != nil {
			t.Fatal(err)
		}
		got, err := phone.store.ContinueWatching(phone.profile.ID)
		check(t, err)
		if len(got) == 1 && got[0].Position == saved.Position {
			break
		}
		if time.Since(start) > 30*time.Second {
			t.Fatalf("the other device's continue watching after 30 s: %+v; still queued on the desktop: %+v", got, pending(t, desktop))
		}
		time.Sleep(time.Second)
	}
	t.Logf("progress reached the other device in %v", time.Since(start).Round(100*time.Millisecond))
}
