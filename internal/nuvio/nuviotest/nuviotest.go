// Package nuviotest is a fake Nuvio backend for tests.
package nuviotest

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync"
	"sync/atomic"
	"testing"
)

// The fake backend's publishable key, the password it accepts and the
// session it hands out.
const (
	Key          = "sb_publishable_test"
	Password     = "correct horse"
	AccessToken  = "access-token"
	RefreshToken = "refresh-token"
)

// Server is a fake Nuvio backend. It answers like api.nuvio.tv: the discovery
// document, GoTrue's password grant and the RPCs the client calls, with the
// shapes and errors the M0 spike saw on live (docs/spikes/nuvio-backend.md).
// It is safe for concurrent requests.
type Server struct {
	*httptest.Server

	// Answers 429 to this many sign-ins before answering.
	Limited atomic.Int32
	// Answers 500 to sync_pull_profiles while set.
	FailProfiles atomic.Bool

	mu     sync.Mutex
	calls  []string
	bodies map[string]map[string]any
	agents []string
}

// NewServer starts a fake backend that stops when the test ends.
func NewServer(t testing.TB) *Server {
	t.Helper()
	s := &Server{bodies: map[string]map[string]any{}}
	s.Server = httptest.NewServer(http.HandlerFunc(s.serve))
	t.Cleanup(s.Close)
	return s
}

// Calls returns the method and path of every request after discovery, in
// order, e.g. "POST /auth/v1/token?grant_type=password".
func (s *Server) Calls() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.calls...)
}

// Body returns the JSON body last sent to path, e.g. "/rest/v1/rpc/sync_pull_profiles".
func (s *Server) Body(path string) map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.bodies[path]
}

// UserAgents returns the User-Agent of every request after discovery.
func (s *Server) UserAgents() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]string(nil), s.agents...)
}

func (s *Server) serve(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "application/json")
	if r.URL.Path == "/.well-known/nuvio" {
		json.NewEncoder(w).Encode(map[string]any{
			"version": 1, "service": "nuvio", "self_hosted": true,
			"backend_url": "http://" + r.Host, "publishable_key": Key,
			"capabilities": map[string]bool{"email_password_auth": true, "tv_login": true},
		})
		return
	}
	var body map[string]any
	json.NewDecoder(r.Body).Decode(&body)
	s.mu.Lock()
	s.calls = append(s.calls, r.Method+" "+r.URL.RequestURI())
	s.bodies[r.URL.Path] = body
	s.agents = append(s.agents, r.Header.Get("User-Agent"))
	s.mu.Unlock()

	if r.Header.Get("Apikey") != Key {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"message":"No API key found in request"}`))
		return
	}

	switch r.URL.Path {
	case "/auth/v1/token":
		if s.Limited.Add(-1) >= 0 {
			w.Header().Set("X-Sb-Error-Code", "over_request_rate_limit")
			w.WriteHeader(http.StatusTooManyRequests)
			w.Write([]byte(`{"code":429,"error_code":"over_request_rate_limit","msg":"Request rate limit reached"}`))
			return
		}
		if body["password"] != Password {
			w.Header().Set("X-Sb-Error-Code", "invalid_credentials")
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"code":400,"error_code":"invalid_credentials","msg":"Invalid login credentials"}`))
			return
		}
		json.NewEncoder(w).Encode(map[string]any{
			"access_token": AccessToken, "token_type": "bearer", "expires_in": 604800,
			"refresh_token": RefreshToken, "user": map[string]any{"email": body["email"]},
		})
	case "/auth/v1/logout":
		w.WriteHeader(http.StatusNoContent)
	case "/rest/v1/rpc/sync_pull_profiles":
		if r.Header.Get("Authorization") != "Bearer "+AccessToken {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"code":"42501","message":"permission denied for function sync_pull_profiles"}`))
			return
		}
		if s.FailProfiles.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"code":"XX000","message":"internal error"}`))
			return
		}
		w.Write([]byte(`[
			{"id":"8f8b0000-0000-0000-0000-000000000001","profile_index":1,"name":"Kevin","avatar_color_hex":"#33B5E0","avatar_id":"a1","avatar_url":null,"pin_enabled":false,"pin_locked_until":null},
			{"id":"8f8b0000-0000-0000-0000-000000000003","profile_index":3,"name":"Kids","avatar_color_hex":"#F5A623","avatar_id":"a7","avatar_url":"https://img/a7.png","pin_enabled":true,"pin_locked_until":null}
		]`))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}
