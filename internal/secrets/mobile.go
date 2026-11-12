package secrets

import (
	"github.com/zalando/go-keyring"
)

// keyValues is a flat store of strings, such as the Keychain wrapper the
// mobile shell gives (Wails' application.Mobile.SecureSet and friends). The
// iOS backend (native_ios.go) is one over it. It is here, without a build tag,
// so macOS tests can run it against a fake.
type keyValues struct {
	set    func(key, value string) error
	get    func(key string) (value string, found bool, err error)
	delete func(key string) error
}

// mobile adapts keyValues to backend. Items are filed under "service/key",
// since the store has no service attribute of its own.
type mobile struct{ kv keyValues }

func itemKey(service, key string) string { return service + "/" + key }

func (m mobile) get(service, key string) (string, error) {
	v, found, err := m.kv.get(itemKey(service, key))
	if err != nil {
		return "", err
	}
	if !found {
		return "", keyring.ErrNotFound
	}
	return v, nil
}

func (m mobile) set(service, key, value string) error {
	return m.kv.set(itemKey(service, key), value)
}

func (m mobile) delete(service, key string) error {
	// Deleting what isn't there succeeds in the store; go-keyring says
	// ErrNotFound, which Keychain.Delete (secrets.go) treats as done.
	return m.kv.delete(itemKey(service, key))
}
