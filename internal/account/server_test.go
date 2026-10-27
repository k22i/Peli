package account

import (
	"errors"
	"path/filepath"
	"slices"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/nuvio/nuviotest"
	"github.com/k22i/Sinag/internal/store"
)

// The acceptance criterion: switching to another server signs out and
// clears what belonged to the account, keeps the Guest, and the next sign-in
// goes to the new server.
func TestSetServerSignsOutAndSwitches(t *testing.T) {
	f := newFixture(t)
	guest, _ := f.store.CurrentProfile()
	if _, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password); err != nil {
		t.Fatal(err)
	}
	db := store.Opened(f.store)
	if err := db.CacheSet("addon:manifest", []byte("{}")); err != nil {
		t.Fatal(err)
	}
	own := nuviotest.NewServer(t)

	server, err := f.service.SetServer(t.Context(), own.URL+"/", "")
	if err != nil {
		t.Fatal(err)
	}
	if want := (Server{URL: own.URL, Custom: true}); server != want {
		t.Fatalf("server = %+v, want %+v", server, want)
	}
	if status, _ := f.service.Status(); status.SignedIn || status.SessionEnded {
		t.Fatalf("status = %+v, want signed out", status)
	}
	if len(f.keychain.items) != 0 {
		t.Fatalf("keychain = %v", f.keychain.items)
	}
	if profiles, _ := db.Profiles(); len(profiles) != 1 || profiles[0].ID != guest.ID {
		t.Fatalf("profiles = %+v, want the Guest only", profiles)
	}
	if _, ok, _ := db.CacheGet("addon:manifest"); ok {
		t.Fatal("the cache was kept")
	}
	if got, _ := db.Server(); got != own.URL {
		t.Fatalf("saved server = %q", got)
	}
	// The old server was told the session ended.
	if calls := f.backend.Calls(); calls[len(calls)-1] != "POST /auth/v1/logout?scope=local" {
		t.Fatalf("old server's calls = %q", calls)
	}

	before := len(f.backend.Calls())
	current, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	if n := len(f.backend.Calls()); n != before {
		t.Fatalf("%d more calls to the old server", n-before)
	}
	// The check before switching, then the sign-in (with the avatar catalog
	// alongside).
	if calls := own.Calls(); len(calls) < 2 || calls[0] != "POST /rest/v1/rpc/get_avatar_catalog" ||
		!slices.Contains(calls, "POST /auth/v1/token?grant_type=password") {
		t.Fatalf("new server's calls = %q", calls)
	}
	if want := own.URL + "/storage/v1/object/public/avatars/animals/otto-v1.png"; current.Avatar != want {
		t.Fatalf("avatar = %q, want the new server's", current.Avatar)
	}

	// And back to Nuvio's.
	if server, err = f.service.SetServer(t.Context(), "", ""); err != nil {
		t.Fatal(err)
	}
	if want := (Server{URL: f.backend.URL}); server != want {
		t.Fatalf("server = %+v, want %+v", server, want)
	}
	if got, _ := db.Server(); got != "" {
		t.Fatalf("saved server = %q", got)
	}
	if status, _ := f.service.Status(); status.SignedIn {
		t.Fatal("still signed in to the custom server")
	}
}

func TestSetServerThatFailsChangesNothing(t *testing.T) {
	for _, tc := range []struct {
		name, url, key, code string
	}{
		{"not a URL", "nuvio.example.com", "", CodeInvalidServerURL},
		{"key with spaces", "https://nuvio.example.com", "a key", CodeInvalidServerKey},
		{"wrong key", "", "wrong", CodeServerKeyRefused},
		{"unreachable", "http://127.0.0.1:1", "", CodeUnreachable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			if _, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password); err != nil {
				t.Fatal(err)
			}
			url := tc.url
			if url == "" {
				url = nuviotest.NewServer(t).URL
			}

			if err := f.service.TestServer(t.Context(), url, tc.key); code(t, err) != tc.code {
				t.Fatalf("TestServer: code %q, want %q (err: %v)", code(t, err), tc.code, err)
			}
			_, err := f.service.SetServer(t.Context(), url, tc.key)
			if code(t, err) != tc.code {
				t.Fatalf("SetServer: code %q, want %q (err: %v)", code(t, err), tc.code, err)
			}
			if status, _ := f.service.Status(); !status.SignedIn {
				t.Fatal("signed out")
			}
			if f.service.Server().Custom {
				t.Fatalf("server = %+v", f.service.Server())
			}
		})
	}
}

func TestServerKeyIsKeptAndRestored(t *testing.T) {
	f := newFixture(t)
	own := nuviotest.NewServer(t)
	if err := f.service.TestServer(t.Context(), own.URL, nuviotest.Key); err != nil {
		t.Fatal(err)
	}
	server, err := f.service.SetServer(t.Context(), own.URL, " "+nuviotest.Key+" ")
	if err != nil {
		t.Fatal(err)
	}
	if !server.HasKey || f.keychain.items[KeyServerKey] != nuviotest.Key {
		t.Fatalf("server = %+v, keychain = %v", server, f.keychain.items)
	}
	if _, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password); err != nil {
		t.Fatal(err)
	}

	// A new key for the same server keeps the session.
	if _, err := f.service.SetServer(t.Context(), own.URL, ""); err != nil {
		t.Fatal(err)
	}
	if status, _ := f.service.Status(); !status.SignedIn {
		t.Fatal("a new key signed out")
	}
	if _, ok := f.keychain.items[KeyServerKey]; ok {
		t.Fatal("the old key is still in the keychain")
	}
	if _, err := f.service.SetServer(t.Context(), own.URL, nuviotest.Key); err != nil {
		t.Fatal(err)
	}

	// The next launch starts on the custom server, with its key, before the
	// session's first refresh.
	client := nuvio.New(f.backend.URL, "1.2.3")
	again := NewService(client, f.keychain, f.store)
	if err := again.ServiceStartup(t.Context(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { again.ServiceShutdown() })
	if got := again.Server(); got != (Server{URL: own.URL, Custom: true, HasKey: true}) {
		t.Fatalf("restored server = %+v", got)
	}
	if _, err := client.AvatarCatalog(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestQRSignInNeedsNuviosServer(t *testing.T) {
	f := newFixture(t)
	if _, err := f.service.SetServer(t.Context(), nuviotest.NewServer(t).URL, ""); err != nil {
		t.Fatal(err)
	}
	_, err := f.service.StartQRSignIn(t.Context())
	if !errors.Is(err, ErrQRUnavailable) || code(t, err) != CodeQRUnavailable {
		t.Fatalf("err = %v", err)
	}
}

func TestSetServerAsksTheParent(t *testing.T) {
	f, _, _ := kidsFixture(t)
	_, err := f.service.SetServer(t.Context(), nuviotest.NewServer(t).URL, "")
	wantCode(t, "switch", err, CodeParentPINRequired)
	if f.service.Server().Custom {
		t.Fatal("switched")
	}
}

func TestStartupWithoutCustomServer(t *testing.T) {
	db := store.NewService(filepath.Join(t.TempDir(), "sinag.db"))
	if err := db.ServiceStartup(t.Context(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.ServiceShutdown() })
	service := NewService(nuvio.New(nuvio.DefaultURL, "1.2.3"), &memKeychain{items: map[string]string{}}, db)
	if err := service.ServiceStartup(t.Context(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { service.ServiceShutdown() })
	if got := service.Server(); got != (Server{URL: nuvio.DefaultURL}) {
		t.Fatalf("server = %+v", got)
	}
}
