package account

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/nuvio/nuviotest"
	"github.com/k22i/Sinag/internal/secrets"
	"github.com/k22i/Sinag/internal/store"
)

// memKeychain is an in-memory keychain, so tests never touch the user's.
type memKeychain struct {
	items       map[string]string
	unavailable bool
	failSet     string
}

func (k *memKeychain) Set(key, value string) error {
	if k.unavailable {
		return secrets.ErrUnavailable
	}
	if key == k.failSet {
		return errors.New("keychain: write failed")
	}
	k.items[key] = value
	return nil
}

func (k *memKeychain) Delete(key string) error {
	delete(k.items, key)
	return nil
}

func (k *memKeychain) Available() error {
	if k.unavailable {
		return fmt.Errorf("%w (get %q)", secrets.ErrUnavailable, "probe")
	}
	return nil
}

type fixture struct {
	service  *Service
	backend  *nuviotest.Server
	keychain *memKeychain
	store    *store.Service
}

func newFixture(t *testing.T) fixture {
	t.Helper()
	backend := nuviotest.NewServer(t)
	keychain := &memKeychain{items: map[string]string{}}
	db := store.NewService(filepath.Join(t.TempDir(), "sinag.db"))
	if err := db.ServiceStartup(t.Context(), application.ServiceOptions{}); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.ServiceShutdown() })
	service := NewService(nuvio.New(backend.URL, "1.2.3"), keychain, db)
	return fixture{service: service, backend: backend, keychain: keychain, store: db}
}

func TestSignIn(t *testing.T) {
	f := newFixture(t)
	guest, err := f.store.CurrentProfile()
	if err != nil {
		t.Fatal(err)
	}

	current, err := f.service.SignIn(t.Context(), "  me@example.com ", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}

	// The lowest Nuvio profile is current; the guest's profile stays.
	if current.Name != "Kevin" || current.NuvioIndex == nil || *current.NuvioIndex != 1 {
		t.Fatalf("current = %+v", current)
	}
	if got, _ := f.store.CurrentProfile(); got.ID != current.ID {
		t.Fatalf("store's current profile = %+v, want %+v", got, current)
	}
	profiles, _ := f.store.Profiles()
	if len(profiles) != 3 || profiles[0] != guest || profiles[2].Name != "Kids" {
		t.Fatalf("profiles = %+v", profiles)
	}

	// The session is in the keychain, as two items.
	want := map[string]string{KeyAccessToken: nuviotest.AccessToken, KeyRefreshToken: nuviotest.RefreshToken}
	if fmt.Sprint(f.keychain.items) != fmt.Sprint(want) {
		t.Fatalf("keychain = %v", f.keychain.items)
	}

	if email := f.backend.Body("/auth/v1/token")["email"]; email != "me@example.com" {
		t.Fatalf("email sent = %q, want it trimmed", email)
	}
	if calls := f.backend.Calls(); len(calls) != 2 {
		t.Fatalf("calls = %q, want a sign-in and a profile pull", calls)
	}
}

func TestSignInTwiceKeepsProfiles(t *testing.T) {
	f := newFixture(t)
	first, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	again, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	if again.ID != first.ID {
		t.Fatalf("signing in again made a new profile: %+v, then %+v", first, again)
	}
	if profiles, _ := f.store.Profiles(); len(profiles) != 2 {
		t.Fatalf("profiles = %+v", profiles)
	}
}

func TestSignInFailures(t *testing.T) {
	for _, tc := range []struct {
		name     string
		password string
		setup    func(fixture)
		code     string
	}{
		{"wrong password", "wrong", nil, CodeInvalidCredentials},
		{"rate limited", nuviotest.Password, func(f fixture) { f.backend.Limited.Store(100) }, CodeRateLimited},
		{"network down", nuviotest.Password, func(f fixture) { f.backend.Close() }, CodeUnreachable},
		{"profiles fail", nuviotest.Password, func(f fixture) { f.backend.FailProfiles.Store(true) }, CodeUnavailable},
		{"no keychain", nuviotest.Password, func(f fixture) { f.keychain.unavailable = true }, CodeKeychainUnavailable},
		{"keychain write fails", nuviotest.Password, func(f fixture) { f.keychain.failSet = KeyRefreshToken }, ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			f := newFixture(t)
			if tc.setup != nil {
				tc.setup(f)
			}
			_, err := f.service.SignIn(t.Context(), "me@example.com", tc.password)
			if err == nil {
				t.Fatal("SignIn succeeded")
			}
			if got := code(t, err); got != tc.code {
				t.Fatalf("code = %q, want %q (err: %v)", got, tc.code, err)
			}
			// Nothing is half-done: no tokens, no linked profiles.
			if len(f.keychain.items) != 0 {
				t.Fatalf("keychain = %v", f.keychain.items)
			}
			if profiles, _ := f.store.Profiles(); len(profiles) != 0 {
				t.Fatalf("profiles = %+v", profiles)
			}
		})
	}
}

func TestNoKeychainSkipsTheBackend(t *testing.T) {
	f := newFixture(t)
	f.keychain.unavailable = true
	f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password)
	if calls := f.backend.Calls(); len(calls) != 0 {
		t.Fatalf("calls = %q, want none", calls)
	}
}

// code returns the code MarshalError gives err, or "".
func code(t *testing.T, err error) string {
	t.Helper()
	data := MarshalError(err)
	if data == nil {
		return ""
	}
	var cause struct{ Code string }
	if err := json.Unmarshal(data, &cause); err != nil {
		t.Fatal(err)
	}
	return cause.Code
}
