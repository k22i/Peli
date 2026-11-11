package secrets

import (
	"bytes"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/k22i/Peli/internal/store"
)

// These tests use the OS keychain, under their own service name, and remove
// what they write. Run them with PELI_KEYCHAIN_TEST=1; CI does on every OS.

func osKeychain(t *testing.T) *Keychain {
	t.Helper()
	if realKeychain != "1" {
		t.Skip("set PELI_KEYCHAIN_TEST=1 to use the OS keychain")
	}
	k := New(fmt.Sprintf("Peli-test-%d", os.Getpid()))
	t.Cleanup(func() {
		for _, key := range []string{"nuvio.access-token", "nuvio.refresh-token", "debrid.torbox", "big"} {
			k.Delete(key)
		}
	})
	return k
}

func TestOSKeychain(t *testing.T) {
	k := osKeychain(t)
	check(t, k.Available())

	if _, err := k.Get("nuvio.access-token"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get before Set = %v, want ErrNotFound", err)
	}
	for _, value := range []string{token, "rotated", "ünïcødé 🔑\nsecond line", strings.Repeat("x", MaxSize)} {
		check(t, k.Set("nuvio.access-token", value))
		got, err := k.Get("nuvio.access-token")
		check(t, err)
		if got != value {
			t.Fatalf("Get = %q, want %q", got, value)
		}
	}
	check(t, k.Delete("nuvio.access-token"))
	check(t, k.Delete("nuvio.access-token"))
	if _, err := k.Get("nuvio.access-token"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get after Delete = %v, want ErrNotFound", err)
	}
}

// The ticket's acceptance check (#15): after tokens are saved, nothing in the
// app-data directory contains them, in plain, base64 or hex form.
func TestNoTokensInAppData(t *testing.T) {
	k := osKeychain(t)
	dataDir := t.TempDir()
	tokens := map[string]string{
		"nuvio.access-token":  "eyJhbGciOiJIUzI1NiJ9.acceptance-" + fmt.Sprint(os.Getpid()) + ".sig",
		"nuvio.refresh-token": "refresh-acceptance-" + fmt.Sprint(os.Getpid()),
		"debrid.torbox":       "torbox-acceptance-" + fmt.Sprint(os.Getpid()),
	}

	// The app's own writes: a profile, its library and the persisted query
	// cache, next to the tokens going through the secrets service.
	db, err := store.Open(filepath.Join(dataDir, "Peli", "peli.db"))
	check(t, err)
	profile, err := db.CreateProfile(store.Profile{Name: "Kevin"})
	check(t, err)
	check(t, db.SaveLibraryItem(profile.ID, store.LibraryItem{ContentID: "tt1160419", ContentType: "movie", Name: "Dune", AddedAt: 1}))
	check(t, db.CacheSet("peli-query-cache", []byte(`{"clientState":{"queries":[]}}`)))
	service := NewService(k)
	for key, value := range tokens {
		check(t, service.Set(key, value))
	}
	check(t, db.Close())

	files := 0
	err = filepath.WalkDir(dataDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		files++
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		for key, value := range tokens {
			for _, form := range []string{value, base64.StdEncoding.EncodeToString([]byte(value)), hex.EncodeToString([]byte(value))} {
				if bytes.Contains(data, []byte(form)) {
					t.Errorf("%s contains %s", path, key)
				}
			}
		}
		return nil
	})
	check(t, err)
	if files == 0 {
		t.Fatal("no files in the app-data directory to check")
	}

	for key, value := range tokens {
		got, err := service.Get(key)
		check(t, err)
		if got == nil || *got != value {
			t.Fatalf("%s did not round-trip through the keychain", key)
		}
	}
}

// PELI_KEYCHAIN_TEST=unavailable: a Linux machine with no Secret Service gets
// a clear error and nothing is stored anywhere else.
func TestOSKeychainUnavailable(t *testing.T) {
	if realKeychain != "unavailable" {
		t.Skip("set PELI_KEYCHAIN_TEST=unavailable on Linux with no Secret Service")
	}
	k := New("Peli-test")
	for name, err := range map[string]error{
		"Available": k.Available(),
		"Set":       k.Set("trakt.token", token),
	} {
		if !errors.Is(err, ErrUnavailable) {
			t.Fatalf("%s = %v, want ErrUnavailable", name, err)
		}
		if !strings.Contains(err.Error(), "gnome-keyring or KWallet") {
			t.Fatalf("%s error doesn't say what to install: %v", name, err)
		}
		t.Logf("%s: %v", name, err)
	}
}
