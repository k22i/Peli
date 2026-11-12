//go:build darwin && !ios

package secrets

import (
	"errors"
	"fmt"
	"os"
	"testing"

	"github.com/zalando/go-keyring"
)

// The native backend against the real keychain (PELI_KEYCHAIN_TEST=1): items
// the security tool filed move over, and nothing asks "Allow access?". A test
// binary isn't Developer ID signed, so New would pick the tool; this uses
// native directly.
func TestNativeMigratesToolItems(t *testing.T) {
	if realKeychain != "1" {
		t.Skip("set PELI_KEYCHAIN_TEST=1 to use the OS keychain")
	}
	service := fmt.Sprintf("Peli-native-test-%d", os.Getpid())
	n := native{}
	t.Cleanup(func() {
		for _, key := range []string{"nuvio.refresh-token", "debrid.torbox", migrated} {
			n.delete(service, key)
		}
	})

	// What a build before #78 left behind.
	check(t, tool{}.set(service, "nuvio.refresh-token", token))
	check(t, tool{}.set(service, "debrid.torbox", "ünïcødé 🔑"))

	got, err := n.get(service, "nuvio.refresh-token")
	check(t, err)
	if got != token {
		t.Fatalf("native get of the tool's item = %q, want %q", got, token)
	}

	check(t, n.migrate(service))
	if _, err := n.get(service, migrated); err != nil {
		t.Fatalf("no marker after migrate: %v", err)
	}
	for key, want := range map[string]string{"nuvio.refresh-token": token, "debrid.torbox": "ünïcødé 🔑"} {
		if got, err := n.get(service, key); err != nil || got != want {
			t.Fatalf("after migrate, %s = %q, %v; want %q", key, got, err, want)
		}
	}
	check(t, n.migrate(service)) // once is enough: a second run does nothing

	check(t, n.set(service, "debrid.torbox", "rotated"))
	if got, _ := n.get(service, "debrid.torbox"); got != "rotated" {
		t.Fatalf("after set, got %q", got)
	}
	check(t, n.delete(service, "debrid.torbox"))
	if _, err := n.get(service, "debrid.torbox"); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("after delete, err = %v, want not found", err)
	}
	if err := n.delete(service, "debrid.torbox"); !errors.Is(err, keyring.ErrNotFound) {
		t.Fatalf("second delete = %v, want not found", err)
	}
}

func TestNativeEncoding(t *testing.T) {
	for _, value := range []string{"", token, "ünïcødé 🔑\nsecond line"} {
		got, err := decode(encode(value))
		check(t, err)
		if got != value {
			t.Fatalf("decode(encode(%q)) = %q", value, got)
		}
	}
	if got, _ := decode([]byte("plain")); got != "plain" {
		t.Fatalf("plain value decoded to %q", got)
	}
	if got, _ := decode([]byte(hexPrefix + "6869")); got != "hi" {
		t.Fatalf("hex value decoded to %q", got)
	}
}
