package secrets

import "errors"

// Service is the Wails service the frontend calls for secrets. The
// frontend keeps what it reads in memory only: never in localStorage or the
// persisted query cache.
type Service struct {
	keychain *Keychain
}

// NewService returns a service over keychain.
func NewService(keychain *Keychain) *Service {
	return &Service{keychain: keychain}
}

// Get returns the secret at key, or nil if there is none.
func (s *Service) Get(key string) (*string, error) {
	value, err := s.keychain.Get(key)
	if errors.Is(err, ErrNotFound) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	return &value, nil
}

// Set stores value at key, replacing what was there.
func (s *Service) Set(key, value string) error { return s.keychain.Set(key, value) }

// Delete removes key. Deleting a key that isn't there is not an error.
func (s *Service) Delete(key string) error { return s.keychain.Delete(key) }

// Available returns an error saying what to install when there is no
// keychain to use (Linux without a Secret Service), so sign-in can explain it
// up front.
func (s *Service) Available() error { return s.keychain.Available() }
