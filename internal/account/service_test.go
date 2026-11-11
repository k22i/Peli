package account

import (
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/nuvio"
	"github.com/k22i/Peli/internal/nuvio/nuviotest"
	"github.com/k22i/Peli/internal/secrets"
	"github.com/k22i/Peli/internal/store"
)

// memKeychain is an in-memory keychain, so tests never touch the user's.
type memKeychain struct {
	mu          sync.Mutex
	items       map[string]string
	unavailable bool
	failSet     string
}

func (k *memKeychain) Get(key string) (string, error) {
	k.mu.Lock()
	defer k.mu.Unlock()
	if k.unavailable {
		return "", secrets.ErrUnavailable
	}
	value, ok := k.items[key]
	if !ok {
		return "", fmt.Errorf("%w (get %q)", secrets.ErrNotFound, key)
	}
	return value, nil
}

func (k *memKeychain) Set(key, value string) error {
	k.mu.Lock()
	defer k.mu.Unlock()
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
	k.mu.Lock()
	defer k.mu.Unlock()
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
	db := store.NewService(filepath.Join(t.TempDir(), "peli.db"))
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
	access, refresh := f.backend.Tokens()
	want := map[string]string{KeyAccessToken: access, KeyRefreshToken: refresh}
	if fmt.Sprint(f.keychain.items) != fmt.Sprint(want) {
		t.Fatalf("keychain = %v", f.keychain.items)
	}

	if email := f.backend.Body("/auth/v1/token")["email"]; email != "me@example.com" {
		t.Fatalf("email sent = %q, want it trimmed", email)
	}
	if calls := f.backend.Calls(); len(calls) != 4 {
		t.Fatalf("calls = %q, want a sign-in, a profile pull, the profile locks and the avatar catalog", calls)
	}

	// Avatars: a stock one from the catalog, or the profile's own image.
	kevin, kids := profiles[1], profiles[2]
	if want := f.backend.URL + "/storage/v1/object/public/avatars/animals/otto-v1.png"; kevin.Avatar != want || kevin.AvatarColor != "#33B5E0" {
		t.Fatalf("Kevin's avatar = %q on %q", kevin.Avatar, kevin.AvatarColor)
	}
	if kids.Avatar != "https://img/a7.png" || kids.AvatarColor != "#F5A623" {
		t.Fatalf("Kids' avatar = %q on %q", kids.Avatar, kids.AvatarColor)
	}
}

func TestSignInWithoutAvatarCatalog(t *testing.T) {
	f := newFixture(t)
	f.backend.FailAvatars.Store(true)

	current, err := f.service.SignIn(t.Context(), "me@example.com", nuviotest.Password)
	if err != nil {
		t.Fatal(err)
	}
	// Initials on the profile's colour instead; an image of its own still
	// shows.
	if current.Avatar != "" || current.AvatarColor != "#33B5E0" {
		t.Fatalf("current = %+v", current)
	}
	if profiles, _ := f.store.Profiles(); profiles[1].Avatar != "https://img/a7.png" {
		t.Fatalf("profiles = %+v", profiles)
	}
}

func TestAvatarImage(t *testing.T) {
	images := map[string]string{"a1": "https://api/a1.png"}
	for _, tc := range []struct {
		own, id, want string
	}{
		{"", "a1", "https://api/a1.png"},
		{"https://cdn/me.png", "a1", "https://cdn/me.png"},
		{"javascript:alert(1)", "a1", "https://api/a1.png"},
		{"", "gone", ""},
	} {
		p := nuvio.Profile{AvatarID: &tc.id}
		if tc.own != "" {
			p.AvatarURL = &tc.own
		}
		if got := avatarImage(p, images); got != tc.want {
			t.Errorf("avatarImage(%q, %q) = %q, want %q", tc.own, tc.id, got, tc.want)
		}
	}
	for color, want := range map[string]string{"#33b5e0": "#33B5E0", "33B5E0": "", "#33B5E": "", "red": "", "#GGGGGG": ""} {
		if got := hexColor(color); got != want {
			t.Errorf("hexColor(%q) = %q, want %q", color, got, want)
		}
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
