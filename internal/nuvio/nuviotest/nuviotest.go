// Package nuviotest is a fake Nuvio backend for tests.
package nuviotest

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

// The fake backend's publishable key and the password it accepts.
const (
	Key      = "sb_publishable_test"
	Password = "correct horse"
)

// UserID is the id of the account an email signs in to.
func UserID(email string) string { return "user:" + email }

// Server is a fake Nuvio backend. It answers like api.nuvio.tv: the discovery
// document, GoTrue's password and refresh grants, logout and the RPCs the
// client calls, with the shapes and errors the M0 spike and #22 saw on live
// (docs/spikes/nuvio-backend.md). Access tokens are JWT-shaped (unsigned)
// and refresh tokens rotate on use, as on live. It is safe for concurrent
// requests.
type Server struct {
	*httptest.Server

	// Answers 429 to this many sign-ins before answering.
	Limited atomic.Int32
	// Answers 500 to sync_pull_profiles while set.
	FailProfiles atomic.Bool
	// Answers 500 to get_avatar_catalog while set.
	FailAvatars atomic.Bool
	// How long access tokens last; 7 days, as on live, if unset.
	Lifetime atomic.Int64

	mu       sync.Mutex
	calls    []string
	bodies   map[string]map[string]any
	agents   []string
	issued   int
	sessions map[string]*session // by refresh token, used ones included
	access   map[string]*session
	last     [2]string
}

type session struct {
	user    string
	refresh string // the newest refresh token
	parent  string // the one before it, until the newest is used
	issued  map[string]any
	ended   bool
}

// NewServer starts a fake backend that stops when the test ends.
func NewServer(t testing.TB) *Server {
	t.Helper()
	s := &Server{
		bodies:   map[string]map[string]any{},
		sessions: map[string]*session{},
		access:   map[string]*session{},
	}
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

// Tokens returns the access and refresh token handed out last.
func (s *Server) Tokens() (access, refresh string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.last[0], s.last[1]
}

// Revoke ends every session, as signing out everywhere from another device
// does: their refresh tokens stop working. Access tokens keep working until
// they expire, as on live.
func (s *Server) Revoke() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, session := range s.sessions {
		session.ended = true
	}
}

// ExpireAccessTokens makes every access token handed out so far fail with
// 401, as an expired one does. Refresh tokens keep working.
func (s *Server) ExpireAccessTokens() {
	s.mu.Lock()
	defer s.mu.Unlock()
	clear(s.access)
}

// issue hands out a new access and refresh token for session. s.mu is held.
func (s *Server) issue(session *session) map[string]any {
	s.issued++
	lifetime := time.Duration(s.Lifetime.Load()) * time.Second
	if lifetime == 0 {
		lifetime = 7 * 24 * time.Hour
	}
	claims, _ := json.Marshal(map[string]any{
		"sub": session.user, "exp": time.Now().Add(lifetime).Unix(), "iat": time.Now().Unix(),
		"role": "authenticated", "n": s.issued,
	})
	enc := base64.RawURLEncoding.EncodeToString
	access := enc([]byte(`{"alg":"HS256","typ":"JWT"}`)) + "." + enc(claims) + ".c2lnbmF0dXJl"
	refresh := fmt.Sprintf("refresh-%d", s.issued)
	session.parent, session.refresh = session.refresh, refresh
	s.sessions[refresh] = session
	s.access[access] = session
	s.last = [2]string{access, refresh}
	session.issued = map[string]any{
		"access_token": access, "token_type": "bearer", "expires_in": int64(lifetime / time.Second),
		"refresh_token": refresh, "user": map[string]any{"id": session.user},
	}
	return session.issued
}

func authError(w http.ResponseWriter, status int, code, msg string) {
	w.Header().Set("X-Sb-Error-Code", code)
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"code":%d,"error_code":%q,"msg":%q}`, status, code, msg)
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
	defer s.mu.Unlock()
	s.calls = append(s.calls, r.Method+" "+r.URL.RequestURI())
	s.bodies[r.URL.Path] = body
	s.agents = append(s.agents, r.Header.Get("User-Agent"))

	if r.Header.Get("Apikey") != Key {
		w.WriteHeader(http.StatusUnauthorized)
		w.Write([]byte(`{"message":"No API key found in request"}`))
		return
	}
	bearer := s.access[strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer ")]

	switch r.URL.Path {
	case "/auth/v1/token":
		if r.URL.Query().Get("grant_type") == "refresh_token" {
			s.refresh(w, body)
			return
		}
		if s.Limited.Add(-1) >= 0 {
			authError(w, http.StatusTooManyRequests, "over_request_rate_limit", "Request rate limit reached")
			return
		}
		if body["password"] != Password {
			authError(w, http.StatusBadRequest, "invalid_credentials", "Invalid login credentials")
			return
		}
		email, _ := body["email"].(string)
		json.NewEncoder(w).Encode(s.issue(&session{user: UserID(email)}))
	case "/auth/v1/logout":
		if bearer == nil {
			authError(w, http.StatusUnauthorized, "bad_jwt", "invalid JWT")
			return
		}
		bearer.ended = true
		w.WriteHeader(http.StatusNoContent)
	case "/rest/v1/rpc/sync_pull_profiles":
		if bearer == nil {
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
	case "/rest/v1/rpc/get_avatar_catalog":
		// Public, as on live: the publishable key is enough.
		if s.FailAvatars.Load() {
			w.WriteHeader(http.StatusInternalServerError)
			w.Write([]byte(`{"code":"XX000","message":"internal error"}`))
			return
		}
		w.Write([]byte(`[
			{"id":"a1","display_name":"Otto","storage_path":"animals/otto-v1.png","category":"animals","sort_order":1,"is_active":true,"bg_color":"#0BB5AE"},
			{"id":"a7","display_name":"Pip","storage_path":"animals/pip-v1.png","category":"animals","sort_order":2,"is_active":true,"bg_color":"#45B5EE"}
		]`))
	default:
		w.WriteHeader(http.StatusNotFound)
	}
}

// refresh answers GoTrue's refresh grant as live and self-host do (#22): the
// newest refresh token rotates; the one before it, reused while the newest
// is unused, gets the newest session again however late; an older one is
// refused, and the newest keeps working. s.mu is held.
func (s *Server) refresh(w http.ResponseWriter, body map[string]any) {
	token, _ := body["refresh_token"].(string)
	session := s.sessions[token]
	switch {
	case session == nil || session.ended:
		authError(w, http.StatusBadRequest, "refresh_token_not_found", "Invalid Refresh Token: Refresh Token Not Found")
	case token == session.refresh:
		json.NewEncoder(w).Encode(s.issue(session))
	case token == session.parent:
		json.NewEncoder(w).Encode(session.issued)
	default:
		authError(w, http.StatusBadRequest, "refresh_token_already_used", "Invalid Refresh Token: Already Used")
	}
}
