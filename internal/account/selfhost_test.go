package account

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
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
	// The refresher may have rotated again since the last call, so compare
	// the keychain with the session, not with what the calls saw.
	service.session.mu.Lock()
	current := service.session.current.RefreshToken
	service.session.mu.Unlock()
	keychainRefresh, _ := keychain.Get(KeyRefreshToken)
	t.Logf("%v: calls saw %d refreshes, %d network drops; keychain has the session's token: %v",
		length, rotations, drops, keychainRefresh == current)
	if want := int(length / time.Minute); rotations < want-1 {
		t.Errorf("%d refreshes in %v, want about one a minute", rotations, length)
	}
	if keychainRefresh != current || ended.Load() != 0 {
		t.Fatalf("keychain has the session's refresh token: %v; ended %d times", keychainRefresh == current, ended.Load())
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
	// A self-host signup has no Nuvio profiles, and with none linked an
	// ended session is just signed out.
	linked, _ := store.Opened(db).HasNuvioProfiles()
	st, err := service.Status()
	if _, kerr := keychain.Get(KeyRefreshToken); err != nil || st.SignedIn || st.SessionEnded != linked || kerr == nil {
		t.Fatalf("status = %+v, %v (profiles linked: %v); refresh token still in the keychain: %v", st, err, linked, kerr == nil)
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

// TestSelfHostProfiles adds, edits and deletes profiles (#95) against a
// self-hosted Nuvio backend at NUVIO_URL, on a throwaway account it signs up
// itself, and checks the other profiles are untouched. Never live: it
// writes profiles.
func TestSelfHostProfiles(t *testing.T) {
	url := os.Getenv("NUVIO_URL")
	if url == "" || url == nuvio.DefaultURL {
		t.Skip("set NUVIO_URL to a self-hosted backend, not live")
	}
	email, password := "sinag-profiles-"+strconv.FormatInt(time.Now().UnixNano(), 36)+"@example.com", "throwaway-"+strconv.Itoa(os.Getpid())
	if err := signUp(t.Context(), url, email, password); err != nil {
		t.Fatal(err)
	}
	client := nuvio.New(url, "0.0.0-selfhost")
	// A new account has no profiles: Nuvio's apps make profile 1, as here.
	s, err := client.SignInWithPassword(t.Context(), email, password)
	if err != nil {
		t.Fatal(err)
	}
	avatars, err := client.AvatarCatalog(t.Context())
	if err != nil || len(avatars) < 2 {
		t.Fatalf("catalog: %d avatars, %v", len(avatars), err)
	}
	if err := client.PushProfiles(t.Context(), s, []nuvio.Profile{{Index: 1, Name: "Main", AvatarColor: "#33B5E0", AvatarID: &avatars[0].ID}}); err != nil {
		t.Fatal(err)
	}
	pull := func() []nuvio.Profile {
		t.Helper()
		profiles, err := client.Profiles(t.Context(), s)
		if err != nil {
			t.Fatal(err)
		}
		return profiles
	}
	before := pull()[0]

	db := store.NewService(filepath.Join(t.TempDir(), "sinag.db"))
	if err := db.ServiceStartup(t.Context(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.ServiceShutdown() })
	service := NewService(client, &memKeychain{items: map[string]string{}}, db)
	main, err := service.SignIn(t.Context(), email, password)
	if err != nil {
		t.Fatal(err)
	}

	added, err := service.AddProfile(t.Context(), ProfileEdit{Name: "Second", AvatarID: avatars[1].ID, AvatarColor: "#43A047"})
	if err != nil {
		t.Fatal(err)
	}
	edited, err := service.EditProfile(t.Context(), added.ID, ProfileEdit{Name: "Renamed", AvatarID: avatars[0].ID, AvatarColor: "#E53935"})
	if err != nil {
		t.Fatal(err)
	}
	remote := pull()
	t.Logf("after add and edit: %+v", remote)
	if len(remote) != 2 || remote[1].Index != 2 || remote[1].Name != "Renamed" || *remote[1].AvatarID != avatars[0].ID ||
		remote[1].AvatarColor != "#E53935" || edited.Name != "Renamed" {
		t.Fatalf("remote = %+v, edited = %+v", remote, edited)
	}
	if got := remote[0]; got.Name != before.Name || got.AvatarColor != before.AvatarColor || *got.AvatarID != *before.AvatarID ||
		got.UsesPrimaryAddons != before.UsesPrimaryAddons || got.PinEnabled != before.PinEnabled {
		t.Fatalf("profile 1 changed: %+v, was %+v", got, before)
	}

	if err := service.DeleteProfile(t.Context(), added.ID); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteProfile(t.Context(), main.ID); !errors.Is(err, ErrPrimaryProfile) {
		t.Fatalf("deleting the primary: %v", err)
	}
	if remote := pull(); len(remote) != 1 || remote[0].Name != "Main" {
		t.Fatalf("after delete: %+v", remote)
	}
}

// signUp makes a throwaway account; self-hosted Nuvio confirms it at once.
func signUp(ctx context.Context, url, email, password string) error {
	res, err := http.Get(url + "/.well-known/nuvio")
	if err != nil {
		return err
	}
	var doc struct {
		PublishableKey string `json:"publishable_key"`
	}
	json.NewDecoder(res.Body).Decode(&doc)
	res.Body.Close()
	body, _ := json.Marshal(map[string]string{"email": email, "password": password})
	req, _ := http.NewRequestWithContext(ctx, http.MethodPost, url+"/auth/v1/signup", bytes.NewReader(body))
	req.Header.Set("Apikey", doc.PublishableKey)
	req.Header.Set("Content-Type", "application/json")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return errors.New("signup: " + res.Status)
	}
	return nil
}
