package secrets

import "github.com/zalando/go-keyring"

// backend is how a Keychain reaches the OS keychain. Errors are go-keyring's
// (keyring.ErrNotFound and so on) or OS errors; wrap turns them into ours.
type backend interface {
	get(service, key string) (string, error)
	set(service, key, value string) error
	delete(service, key string) error
}

// tool is go-keyring: /usr/bin/security on macOS, Credential Manager on
// Windows and the Secret Service on Linux. On macOS its items trust the
// security tool rather than Peli, so they read without a prompt whatever
// Peli's signature, but so can anything else that runs the tool. A Developer
// ID build uses the native backend instead (#78, see native_darwin.go).
type tool struct{}

func (tool) get(service, key string) (string, error) { return keyring.Get(service, key) }
func (tool) set(service, key, value string) error    { return keyring.Set(service, key, value) }
func (tool) delete(service, key string) error        { return keyring.Delete(service, key) }
