// Package secrets keeps tokens and keys in the OS keychain: the macOS
// Keychain, Windows Credential Manager or the Linux Secret Service
// (gnome-keyring, KWallet). Nothing is ever written to a file, and there is no
// plaintext fallback when the keychain is missing (ADR-0007). On macOS a
// Developer ID build calls Security.framework itself, so its items trust
// Peli's signature; other builds go through /usr/bin/security (ADR-0053).
//
// Errors name the key and the operation, never the value.
package secrets

import (
	"errors"
	"fmt"
	"regexp"
	"sync"

	"github.com/zalando/go-keyring"
)

// ServiceName is the keychain service name Peli's items are filed under.
const ServiceName = "Peli"

// LegacyServiceName is where the items were filed when the app was called
// Sinag. The app's keychain moves an item from there the first time it reads
// it (see MovesFrom).
const LegacyServiceName = "Sinag"

// MaxSize is the largest value Set accepts, in bytes. Windows Credential
// Manager caps a credential at 2,560 bytes; the same cap on every OS keeps a
// value that works on one OS from failing on another. Store a session's access
// and refresh tokens under separate keys.
const MaxSize = 2560

var (
	ErrNotFound    = errors.New("secrets: not found")
	ErrInvalidKey  = errors.New("secrets: invalid key")
	ErrTooLarge    = fmt.Errorf("secrets: value is larger than %d bytes", MaxSize)
	ErrUnavailable = errors.New("secrets: " + unavailableHint)
)

// Keys are lowercase, dot-separated names such as "nuvio.refresh-token" or
// "debrid.torbox".
var keyPattern = regexp.MustCompile(`^[a-z0-9]+(?:[._-][a-z0-9]+)*$`)

const maxKeyLen = 64

// Keychain reads and writes the items of one keychain service.
type Keychain struct {
	service string
	legacy  string
	os      backend
	once    sync.Once
}

// New returns the keychain for service. The app uses ServiceName; tests use
// their own so they never touch the user's items.
func New(service string) *Keychain {
	return &Keychain{service: service, os: osBackend()}
}

// ready moves the service's items to the native macOS backend the first
// time a Developer ID build uses them (native_darwin.go). A failure leaves
// them where they were, still readable, and the next launch tries again.
func (k *Keychain) ready() {
	k.once.Do(func() {
		if m, ok := k.os.(interface{ migrate(string) error }); ok {
			_ = m.migrate(k.service)
		}
	})
}

// MovesFrom has k move items over from the legacy service: Get falls back to
// it for a key k doesn't have, and copies what it finds into k's service
// before deleting it there; Delete removes the key from both services. It
// returns k.
func (k *Keychain) MovesFrom(legacy string) *Keychain {
	k.legacy = legacy
	return k
}

// Get returns the value stored at key, or ErrNotFound.
func (k *Keychain) Get(key string) (string, error) {
	if err := validKey(key); err != nil {
		return "", err
	}
	k.ready()
	value, err := k.os.get(k.service, key)
	if errors.Is(err, keyring.ErrNotFound) && k.legacy != "" {
		return k.move(key)
	}
	if err != nil {
		return "", wrap("get", key, err)
	}
	return value, nil
}

// move reads key from the legacy service and files it under k's own. If the
// copy fails the legacy item stays, so the next Get tries again.
func (k *Keychain) move(key string) (string, error) {
	value, err := k.os.get(k.legacy, key)
	if err != nil {
		return "", wrap("get", key, err)
	}
	if err := k.Set(key, value); err == nil {
		_ = k.os.delete(k.legacy, key)
	}
	return value, nil
}

// Set stores value at key, replacing what was there.
func (k *Keychain) Set(key, value string) error {
	if err := validKey(key); err != nil {
		return err
	}
	if len(value) > MaxSize {
		return fmt.Errorf("%w (set %q)", ErrTooLarge, key)
	}
	k.ready()
	return wrap("set", key, k.os.set(k.service, key, value))
}

// Delete removes key. Deleting a key that isn't there is not an error.
func (k *Keychain) Delete(key string) error {
	if err := validKey(key); err != nil {
		return err
	}
	k.ready()
	if k.legacy != "" {
		// Or a key signed out of before it was ever read would come back.
		if err := wrap("delete", key, k.os.delete(k.legacy, key)); err != nil && !errors.Is(err, ErrNotFound) {
			return err
		}
	}
	err := wrap("delete", key, k.os.delete(k.service, key))
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

// Available reports whether the keychain can be used, by reading a key that
// is never written. It returns ErrUnavailable on Linux when no Secret Service
// is running.
func (k *Keychain) Available() error {
	_, err := k.Get("probe")
	if errors.Is(err, ErrNotFound) {
		return nil
	}
	return err
}

func validKey(key string) error {
	if len(key) > maxKeyLen || !keyPattern.MatchString(key) {
		return fmt.Errorf("%w %q", ErrInvalidKey, key)
	}
	return nil
}

// wrap maps the backends' errors onto ours. The value is never part of err:
// go-keyring passes it to the OS on stdin (macOS) or in a struct, and its
// errors are exit statuses and OS error codes, as the native backend's are
// OSStatus codes.
func wrap(op, key string, err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, keyring.ErrNotFound):
		return fmt.Errorf("%w (%s %q)", ErrNotFound, op, key)
	case errors.Is(err, keyring.ErrSetDataTooBig):
		return fmt.Errorf("%w (%s %q)", ErrTooLarge, op, key)
	case errors.Is(err, keyring.ErrUnsupportedPlatform) || isUnavailable(err):
		return fmt.Errorf("%w (%s %q: %v)", ErrUnavailable, op, key, err)
	}
	return fmt.Errorf("secrets: %s %q: %w", op, key, err)
}
