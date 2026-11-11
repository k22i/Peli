package account

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"

	"github.com/k22i/Peli/internal/nuvio"
	"github.com/k22i/Peli/internal/secrets"
	"github.com/k22i/Peli/internal/store"
)

// A custom server (#34, ADR-0021): the user's own Nuvio-compatible backend,
// such as NuvioMedia/self-host, in place of Nuvio's. Its URL is kept in the
// local store and its key, when it needs one, in the keychain. A session
// belongs to one server, so switching signs out first.

// KeyServerKey is the keychain key for a custom server's publishable key.
const KeyServerKey = "nuvio.server-key"

var (
	// ErrInvalidServerURL means the address isn't an http or https URL.
	ErrInvalidServerURL = errors.New("account: not a server address")
	// ErrInvalidServerKey means the key has spaces in it or is too long for
	// the keychain.
	ErrInvalidServerKey = errors.New("account: not a server key")
	// ErrQRUnavailable means QR sign-in was asked for on a custom server:
	// the phone approves sign-ins to Nuvio's backend only.
	ErrQRUnavailable = errors.New("account: QR sign-in needs Nuvio's server")
)

// Server is the backend Peli signs in to.
type Server struct {
	URL string `json:"url"`
	// The user's own, not Nuvio's.
	Custom bool `json:"custom"`
	// A key for it is in the keychain. Otherwise the key is the one the
	// server publishes at /.well-known/nuvio.
	HasKey bool `json:"hasKey"`
}

// Server returns the backend Peli signs in to.
func (s *Service) Server() Server {
	server := Server{URL: s.nuvio.ServerURL(), Custom: s.customServer()}
	if server.Custom {
		key, err := s.session.keychain.Get(KeyServerKey)
		server.HasKey = err == nil && key != ""
	}
	return server
}

func (s *Service) customServer() bool { return s.nuvio.ServerURL() != s.defaultServer }

// TestServer checks that url is a Nuvio backend that takes key, or the key
// it publishes when key is "", without switching to it or writing anything.
func (s *Service) TestServer(ctx context.Context, url, key string) error {
	url, key, err := s.parseServer(url, key)
	if err != nil {
		return err
	}
	return s.nuvio.CheckServer(ctx, url, key)
}

// SetServer switches to the backend at url, with key as its publishable key
// or "" for the one it publishes. An empty url, or Nuvio's, goes back to
// Nuvio's server. The server is checked first, and nothing changes if it
// fails. Switching to another server signs out as SignOut does, so the
// account's profiles and the cache go; a Guest profile stays. Giving the same
// server a new key keeps the session.
func (s *Service) SetServer(ctx context.Context, url, key string) (Server, error) {
	url, key, err := s.parseServer(url, key)
	if err != nil {
		return Server{}, err
	}
	custom := url != s.defaultServer
	if custom {
		if err := s.nuvio.CheckServer(ctx, url, key); err != nil {
			return Server{}, err
		}
	}
	if key != "" {
		if err := s.session.keychain.Available(); err != nil {
			return Server{}, err
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if url != s.nuvio.ServerURL() {
		// Signing out leaves a kids profile.
		if err := s.guardKids(store.Opened(s.store), nil); err != nil {
			return Server{}, err
		}
		if err := s.signOut(ctx); err != nil {
			return Server{}, err
		}
		s.qrMu.Lock()
		s.qr = nil
		s.qrMu.Unlock()
	}
	// The key first: until the URL is saved, the old server is the one
	// restored at launch.
	if key != "" {
		err = s.session.keychain.Set(KeyServerKey, key)
	} else if err = s.session.keychain.Delete(KeyServerKey); errors.Is(err, secrets.ErrUnavailable) {
		// No keychain, so no key in it either.
		err = nil
	}
	if err != nil {
		return Server{}, err
	}
	saved := ""
	if custom {
		saved = url
	}
	if err := store.Opened(s.store).SetServer(saved); err != nil {
		return Server{}, err
	}
	s.nuvio.UseServer(url, key)
	return s.Server(), nil
}

// parseServer checks a server's address and key as the user typed them. An
// empty address is Nuvio's server, which takes no key.
func (s *Service) parseServer(url, key string) (string, string, error) {
	if strings.TrimSpace(url) == "" {
		return s.defaultServer, "", nil
	}
	url, err := nuvio.ParseServerURL(url)
	if err != nil {
		return "", "", fmt.Errorf("%w: %v", ErrInvalidServerURL, err)
	}
	if url == s.defaultServer {
		return url, "", nil
	}
	key = strings.TrimSpace(key)
	if strings.ContainsFunc(key, func(r rune) bool { return r <= ' ' || r > '~' }) || len(key) > secrets.MaxSize {
		return "", "", ErrInvalidServerKey
	}
	return url, key, nil
}

// restoreServer points the client at the server the user picked, if any, at
// launch. A key the keychain can't give (locked, say) is left to the
// server's discovery document.
func (s *Service) restoreServer() {
	url, err := store.Opened(s.store).Server()
	if err != nil || url == "" {
		if err != nil {
			slog.Warn("account: reading the server", "error", err)
		}
		return
	}
	key, err := s.session.keychain.Get(KeyServerKey)
	if err != nil && !errors.Is(err, secrets.ErrNotFound) {
		slog.Warn("account: reading the server's key", "error", err)
	}
	s.nuvio.UseServer(url, key)
}
