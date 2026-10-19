package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/store"
)

// TestLongSession keeps a session going for SINAG_LONG_SESSION (e.g. 10m)
// against a self-hosted Nuvio backend started with short tokens
// (JWT_EXPIRY=120), calling the backend every 10 s across many refreshes.
// Then another device signs out everywhere, and the next refresh must end
// the session but keep the profiles. It needs NUVIO_URL and a throwaway
// account in NUVIO_EMAIL and NUVIO_PASSWORD; never point it at live, where a
// global sign-out would end the user's other sessions.
func TestLongSession(t *testing.T) {
	length, _ := time.ParseDuration(os.Getenv("SINAG_LONG_SESSION"))
	url := os.Getenv("NUVIO_URL")
	if length == 0 || url == "" || url == nuvio.DefaultURL {
		t.Skip("set SINAG_LONG_SESSION, NUVIO_URL (self-hosted, not live), NUVIO_EMAIL and NUVIO_PASSWORD")
	}
	email, password := os.Getenv("NUVIO_EMAIL"), os.Getenv("NUVIO_PASSWORD")
	keychain := &memKeychain{items: map[string]string{}}
	db := store.NewService(filepath.Join(t.TempDir(), "sinag.db"))
	if err := db.ServiceStartup(t.Context(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.ServiceShutdown() })
	client := nuvio.New(url, "0.0.0-long-session")
	service := NewService(client, keychain, db)
	var ended atomic.Int32
	service.session.onEnded = func() { ended.Add(1) }

	if _, err := service.SignIn(t.Context(), email, password); err != nil {
		t.Fatal(err)
	}
	first, _ := service.session.fresh(t.Context())
	t.Logf("signed in; token lasts %v", time.Until(first.ExpiresAt).Round(time.Second))

	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	go service.session.run(ctx, time.Second)

	rotations, drops, last := 0, 0, first.RefreshToken
	for start := time.Now(); time.Since(start) < length; time.Sleep(10 * time.Second) {
		err := service.session.Do(t.Context(), func(s nuvio.Session) error {
			if s.RefreshToken != last {
				rotations, last = rotations+1, s.RefreshToken
			}
			_, err := client.Profiles(t.Context(), s)
			return err
		})
		// The network can drop (the Mac waking from sleep, say); only a lost
		// session fails the test.
		if errors.Is(err, nuvio.ErrUnreachable) {
			t.Logf("after %v: %v", time.Since(start).Round(time.Second), err)
			drops++
		} else if err != nil {
			t.Fatalf("after %v and %d refreshes: %v", time.Since(start).Round(time.Second), rotations, err)
		}
	}
	keychainRefresh := keychain.items[KeyRefreshToken]
	t.Logf("%v: %d refreshes, %d network drops; keychain has the newest token: %v",
		length, rotations, drops, keychainRefresh == last)
	if want := int(length / time.Minute); rotations < want-1 {
		t.Errorf("%d refreshes in %v, want about one a minute", rotations, length)
	}
	if keychainRefresh != last || ended.Load() != 0 {
		t.Fatalf("keychain refresh token is the newest: %v; ended %d times", keychainRefresh == last, ended.Load())
	}

	// Another device signs out everywhere.
	other, err := client.SignInWithPassword(t.Context(), email, password)
	if err != nil {
		t.Fatal(err)
	}
	if err := logoutEverywhere(t.Context(), url, other); err != nil {
		t.Fatal(err)
	}
	cancel()
	service.session.mu.Lock()
	service.session.refreshAt = time.Time{}
	service.session.mu.Unlock()
	err = service.session.refreshIfDue(t.Context())
	t.Logf("refresh after signing out everywhere: %v", err)
	if !errors.Is(err, nuvio.ErrSignedOut) || ended.Load() != 1 {
		t.Fatalf("refresh = %v, ended %d times; want ErrSignedOut, once", err, ended.Load())
	}
	st, err := service.Status()
	if err != nil || !st.SessionEnded || len(keychain.items) != 0 {
		t.Fatalf("status = %+v, %v; keychain has %d items", st, err, len(keychain.items))
	}
}

// logoutEverywhere is GoTrue's global sign-out, which Sinag doesn't offer.
func logoutEverywhere(ctx context.Context, url string, s nuvio.Session) error {
	res, err := http.Get(url + "/.well-known/nuvio")
	if err != nil {
		return err
	}
	var doc struct {
		PublishableKey string `json:"publishable_key"`
	}
	json.NewDecoder(res.Body).Decode(&doc)
	res.Body.Close()
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url+"/auth/v1/logout?scope=global", bytes.NewReader(nil))
	req.Header.Set("Apikey", doc.PublishableKey)
	req.Header.Set("Authorization", "Bearer "+s.AccessToken)
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		return errors.New("global logout: " + res.Status)
	}
	return nil
}
