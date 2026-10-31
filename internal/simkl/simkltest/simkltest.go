// Package simkltest is a fake SIMKL API for tests: the device sign-in,
// token refresh, scrobbles, the history and the library, kept in memory and
// shaped as api.simkl.org documents them.
package simkltest

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"sync"
	"testing"
)

// ClientID is the app the fake accepts.
const ClientID = "test-client"

// Scrobble is a scrobble call the fake got.
type Scrobble struct {
	Action      string
	Progress    float64
	MinProgress int
	Body        map[string]any
}

// Server is the fake.
type Server struct {
	*httptest.Server

	mu sync.Mutex
	// Approved is whether the pending device code was approved.
	Approved bool
	// Scope is what a new grant gets.
	Scope string
	// Access is the access token that works now; Refresh the refresh token.
	Access, Refresh string
	// Refreshes counts refresh grants.
	Refreshes int
	// Down answers every call with a 503.
	Down bool
	// Done makes the next stop answer 409, as one SIMKL already finalized.
	Done bool

	Scrobbles []Scrobble
	History   []map[string]any
	// Activities and Library are what the user's lists answer;
	// LibraryCalls are the all-items paths and queries asked.
	Activities   map[string]any
	Library      map[string]map[string]any
	LibraryCalls []string
	tokens       int
}

// New starts a fake with one user, "kevin".
func New(t testing.TB) *Server {
	s := &Server{Scope: "media:read media:write", Library: map[string]map[string]any{}}
	s.Server = httptest.NewServer(http.HandlerFunc(s.handle))
	t.Cleanup(s.Close)
	return s
}

// Calls returns the scrobbles so far.
func (s *Server) Calls() []Scrobble {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]Scrobble(nil), s.Scrobbles...)
}

// Histories returns the history posts so far.
func (s *Server) Histories() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return append([]map[string]any(nil), s.History...)
}

// Set changes the fake under its lock.
func (s *Server) Set(fn func(s *Server)) {
	s.mu.Lock()
	defer s.mu.Unlock()
	fn(s)
}

func (s *Server) handle(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.Down {
		http.Error(w, `{"error":"down"}`, http.StatusServiceUnavailable)
		return
	}
	if strings.HasPrefix(r.URL.Path, "/oauth2/") {
		s.oauth(w, r)
		return
	}
	q := r.URL.Query()
	if q.Get("client_id") != ClientID || q.Get("app-name") == "" || q.Get("app-version") == "" || r.UserAgent() == "" {
		writeJSON(w, http.StatusPreconditionFailed, map[string]string{"error": "client_id_failed"})
		return
	}
	if r.Header.Get("Authorization") != "Bearer "+s.Access || s.Access == "" {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "user_token_failed"})
		return
	}
	var body map[string]any
	if r.Method == http.MethodPost {
		data, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(data, &body)
	}
	switch {
	case r.URL.Path == "/users/settings":
		writeJSON(w, http.StatusOK, map[string]any{"user": map[string]any{"name": "kevin"}, "account": map[string]any{"id": 1, "type": "free"}})
	case strings.HasPrefix(r.URL.Path, "/scrobble/"):
		action := strings.TrimPrefix(r.URL.Path, "/scrobble/")
		min, _ := strconv.Atoi(q.Get("min_progress"))
		progress, _ := body["progress"].(float64)
		s.Scrobbles = append(s.Scrobbles, Scrobble{Action: action, Progress: progress, MinProgress: min, Body: body})
		if action == "stop" && s.Done {
			s.Done = false
			writeJSON(w, http.StatusConflict, map[string]string{"watched_at": "2026-10-31T00:00:00Z", "expires_at": "2026-10-31T01:00:00Z"})
			return
		}
		answer := action
		if action == "stop" {
			answer = "pause"
			if progress >= float64(max(min, 80)) {
				answer = "scrobble"
			}
		}
		writeJSON(w, http.StatusCreated, map[string]any{"id": len(s.Scrobbles), "action": answer, "progress": progress})
	case r.URL.Path == "/sync/history":
		s.History = append(s.History, body)
		writeJSON(w, http.StatusCreated, map[string]any{"added": map[string]int{}})
	case r.URL.Path == "/sync/activities":
		writeJSON(w, http.StatusOK, s.Activities)
	case strings.HasPrefix(r.URL.Path, "/sync/all-items/"):
		kind := strings.TrimPrefix(r.URL.Path, "/sync/all-items/")
		s.LibraryCalls = append(s.LibraryCalls, kind+"?"+q.Get("date_from"))
		writeJSON(w, http.StatusOK, s.Library[kind])
	default:
		http.NotFound(w, r)
	}
}

func (s *Server) oauth(w http.ResponseWriter, r *http.Request) {
	_ = r.ParseForm()
	if r.PostForm.Get("client_id") != ClientID {
		writeJSON(w, http.StatusUnauthorized, map[string]string{"error": "invalid_client"})
		return
	}
	switch r.URL.Path {
	case "/oauth2/device":
		writeJSON(w, http.StatusOK, map[string]any{
			"device_code": "device-1", "user_code": "BDWP-HQPK",
			"verification_uri":          "https://simkl.com/pin",
			"verification_uri_complete": "https://simkl.com/pin?user_code=BDWP-HQPK",
			"expires_in":                900, "interval": 5,
		})
	case "/oauth2/token":
		switch r.PostForm.Get("grant_type") {
		case "urn:ietf:params:oauth:grant-type:device_code":
			if !s.Approved {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "authorization_pending"})
				return
			}
			s.Approved = false
			s.issue(w, "")
		case "refresh_token":
			if r.PostForm.Get("refresh_token") != s.Refresh || s.Refresh == "" {
				writeJSON(w, http.StatusBadRequest, map[string]string{"error": "invalid_grant"})
				return
			}
			s.Refreshes++
			s.issue(w, s.Refresh)
		}
	case "/oauth2/revoke":
		if token := r.PostForm.Get("token"); token == s.Refresh || token == s.Access {
			s.Access, s.Refresh = "", ""
		}
		w.WriteHeader(http.StatusOK)
	}
}

// issue makes a new access token (the old one stops working), keeping
// refresh if given.
func (s *Server) issue(w http.ResponseWriter, refresh string) {
	s.tokens++
	s.Access = fmt.Sprintf("simkl_at_%d", s.tokens)
	if refresh == "" {
		refresh = fmt.Sprintf("simkl_rt_%d", s.tokens)
	}
	s.Refresh = refresh
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token": s.Access, "refresh_token": s.Refresh, "token_type": "Bearer",
		"expires_in": 604800, "scope": s.Scope,
	})
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}
