package secrets

import (
	"errors"
	"os"
	"strings"
	"testing"

	"github.com/zalando/go-keyring"
)

// realKeychain is set by PELI_KEYCHAIN_TEST: "1" runs the tests in
// keychain_test.go against the OS keychain, "unavailable" checks the error on
// a Linux machine with no Secret Service. Either way the mock tests here are
// skipped, since go-keyring's mock replaces its provider for the whole binary.
var realKeychain = os.Getenv("PELI_KEYCHAIN_TEST")

// mock switches go-keyring to an in-memory keychain, failing every call with
// err when it is set.
func mock(t *testing.T, err error) *Keychain {
	t.Helper()
	if realKeychain != "" {
		t.Skip("PELI_KEYCHAIN_TEST is set: testing the OS keychain")
	}
	if err != nil {
		keyring.MockInitWithError(err)
	} else {
		keyring.MockInit()
	}
	return New("Peli-test")
}

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}

const token = "eyJhbGciOiJIUzI1NiJ9.c2VjcmV0LXRva2Vu.c2lnbmF0dXJl"

func TestRoundTrip(t *testing.T) {
	k := mock(t, nil)

	check(t, k.Set("nuvio.access-token", token))
	got, err := k.Get("nuvio.access-token")
	check(t, err)
	if got != token {
		t.Fatalf("Get = %q, want %q", got, token)
	}

	check(t, k.Set("nuvio.access-token", "rotated"))
	if got, _ := k.Get("nuvio.access-token"); got != "rotated" {
		t.Fatalf("after replace, Get = %q", got)
	}

	check(t, k.Delete("nuvio.access-token"))
	if _, err := k.Get("nuvio.access-token"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("after delete, Get err = %v, want ErrNotFound", err)
	}
	// Deleting again is fine: sign-out shouldn't fail on a missing token.
	check(t, k.Delete("nuvio.access-token"))
}

func TestServicesAreSeparate(t *testing.T) {
	mock(t, nil)
	app, other := New(ServiceName), New("Peli-other")

	check(t, app.Set("debrid.torbox", token))
	if _, err := other.Get("debrid.torbox"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("other service sees the key: err = %v", err)
	}
}

func TestMovesFromLegacy(t *testing.T) {
	mock(t, nil)
	legacy := New("Sinag-test")
	check(t, legacy.Set("nuvio.refresh-token", token))
	check(t, legacy.Set("debrid.torbox", token))
	k := New("Peli-test").MovesFrom("Sinag-test")

	// Read: the item moves across.
	if got, err := k.Get("nuvio.refresh-token"); err != nil || got != token {
		t.Fatalf("Get = %q, %v; want the legacy value", got, err)
	}
	if got, err := New("Peli-test").Get("nuvio.refresh-token"); err != nil || got != token {
		t.Fatalf("after the move, own service has %q, %v", got, err)
	}
	if _, err := legacy.Get("nuvio.refresh-token"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("legacy item still there after the move: err = %v", err)
	}

	// Delete before any read: gone from both, so it can't come back.
	check(t, k.Delete("debrid.torbox"))
	if _, err := k.Get("debrid.torbox"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("deleted key came back: err = %v", err)
	}

	// Missing everywhere: still ErrNotFound.
	if _, err := k.Get("tmdb.api-key"); !errors.Is(err, ErrNotFound) {
		t.Fatalf("Get missing = %v, want ErrNotFound", err)
	}
}

func TestKeys(t *testing.T) {
	k := mock(t, nil)

	for _, key := range []string{"nuvio.access-token", "trakt.token", "debrid.torbox", "a", "profile.3.debrid_key"} {
		if err := k.Set(key, "v"); err != nil {
			t.Errorf("Set(%q) = %v", key, err)
		}
	}
	for _, key := range []string{"", "Nuvio.token", "nuvio token", "nuvio..token", ".token", "token.", "nuvio/token", strings.Repeat("a", maxKeyLen+1)} {
		if err := k.Set(key, "v"); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("Set(%q) = %v, want ErrInvalidKey", key, err)
		}
		if _, err := k.Get(key); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("Get(%q) = %v, want ErrInvalidKey", key, err)
		}
		if err := k.Delete(key); !errors.Is(err, ErrInvalidKey) {
			t.Errorf("Delete(%q) = %v, want ErrInvalidKey", key, err)
		}
	}
}

func TestMaxSize(t *testing.T) {
	k := mock(t, nil)

	check(t, k.Set("big", strings.Repeat("x", MaxSize)))
	err := k.Set("big", strings.Repeat("y", MaxSize+1))
	if !errors.Is(err, ErrTooLarge) {
		t.Fatalf("Set over MaxSize = %v, want ErrTooLarge", err)
	}
	if got, _ := k.Get("big"); got != strings.Repeat("x", MaxSize) {
		t.Fatal("a rejected Set changed the stored value")
	}
}

// A Supabase session is an access token (a JWT, ~1 KB) and a short refresh
// token. Each must fit under MaxSize on its own.
func TestNuvioSessionFits(t *testing.T) {
	k := mock(t, nil)
	access := "eyJhbGciOiJIUzI1NiIsImtpZCI6IjEyMyIsInR5cCI6IkpXVCJ9." + strings.Repeat("Q", 1400) + "." + strings.Repeat("s", 43)
	check(t, k.Set("nuvio.access-token", access))
	check(t, k.Set("nuvio.refresh-token", "v5ivyq2ywa4x"))
}

func TestUnavailable(t *testing.T) {
	k := mock(t, keyring.ErrUnsupportedPlatform)

	for name, err := range map[string]error{
		"Get":       func() error { _, err := k.Get("trakt.token"); return err }(),
		"Set":       k.Set("trakt.token", token),
		"Delete":    k.Delete("trakt.token"),
		"Available": k.Available(),
	} {
		if !errors.Is(err, ErrUnavailable) {
			t.Errorf("%s = %v, want ErrUnavailable", name, err)
		}
	}
}

func TestAvailable(t *testing.T) {
	check(t, mock(t, nil).Available())
}

func TestErrorsNeverHoldTheValue(t *testing.T) {
	for _, mockErr := range []error{errors.New("exit status 36"), keyring.ErrSetDataTooBig, keyring.ErrUnsupportedPlatform} {
		k := mock(t, mockErr)
		err := k.Set("nuvio.access-token", token)
		if err == nil || strings.Contains(err.Error(), token) {
			t.Errorf("Set error = %v", err)
		}
	}
	k := mock(t, nil)
	err := k.Set("nuvio.access-token", token+strings.Repeat("x", MaxSize))
	if err == nil || strings.Contains(err.Error(), token) {
		t.Errorf("Set error = %v", err)
	}
}

func TestService(t *testing.T) {
	s := NewService(mock(t, nil))

	got, err := s.Get("trakt.token")
	check(t, err)
	if got != nil {
		t.Fatalf("Get of a missing key = %q, want nil", *got)
	}

	check(t, s.Set("trakt.token", token))
	got, err = s.Get("trakt.token")
	check(t, err)
	if got == nil || *got != token {
		t.Fatalf("Get = %v, want the token", got)
	}

	check(t, s.Delete("trakt.token"))
	check(t, s.Available())
	if _, err := s.Get("Bad Key"); !errors.Is(err, ErrInvalidKey) {
		t.Fatalf("Get(bad key) = %v, want ErrInvalidKey", err)
	}
}
