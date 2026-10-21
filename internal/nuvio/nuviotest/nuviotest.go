// Package nuviotest is a fake Nuvio backend for tests.
package nuviotest

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"slices"
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
	// Answers 503 to this many device login polls before answering.
	FailPolls atomic.Int32
	// retry_after_seconds returned for a wrong profile PIN (#25).
	PinRetryAfter atomic.Int64

	mu       sync.Mutex
	profiles map[string][]map[string]any // by user, sorted by index
	pins     map[string]map[int]string   // by user id, then profile index
	calls    []string
	bodies   map[string]map[string]any
	agents   []string
	issued   int
	sessions map[string]*session // by refresh token, used ones included
	access   map[string]*session
	last     [2]string
	logins   map[string]*deviceLogin // by device code
	sync     *syncState
}

// deviceLogin is a device login (#21), as tv_login_sessions keeps it.
type deviceLogin struct {
	nonce    string
	userCode string
	status   string // pending, approved, exchanged or expired
	user     string
	expires  time.Time
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
		profiles: map[string][]map[string]any{},
		pins:     map[string]map[int]string{},
		logins:   map[string]*deviceLogin{},
		sync:     newSyncState(),
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

// StartProfiles is what an account's profiles are until it changes them.
const StartProfiles = `[
	{"profile_index":1,"name":"Kevin","avatar_color_hex":"#33B5E0","avatar_id":"a1","avatar_url":null,"uses_primary_addons":false,"uses_primary_plugins":false,"pin_enabled":false,"pin_locked_until":null},
	{"profile_index":3,"name":"Kids","avatar_color_hex":"#F5A623","avatar_id":"a7","avatar_url":"https://img/a7.png","uses_primary_addons":true,"uses_primary_plugins":true,"pin_enabled":true,"pin_locked_until":null}
]`

// Profiles returns the profiles of the account email signs in to, by index.
func (s *Server) Profiles(email string) []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.profilesOf(UserID(email))
}

// SetProfiles replaces the profiles of the account email signs in to, from a
// JSON array like StartProfiles.
func (s *Server) SetProfiles(t testing.TB, email, profiles string) {
	t.Helper()
	var list []map[string]any
	if err := json.Unmarshal([]byte(profiles), &list); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.profiles[UserID(email)] = list
}

// SetProfilePIN sets the PIN for the account's profile at index (#25).
func (s *Server) SetProfilePIN(t testing.TB, email string, index int, pin string) {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	user := UserID(email)
	if s.pins[user] == nil {
		s.pins[user] = map[int]string{}
	}
	s.pins[user][index] = pin
}

// profilesOf returns user's profiles, starting them if it has none yet.
// s.mu is held.
func (s *Server) profilesOf(user string) []map[string]any {
	list, ok := s.profiles[user]
	if !ok {
		json.Unmarshal([]byte(StartProfiles), &list)
		s.profiles[user] = list
	}
	return list
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

// Approve approves the device login with userCode as the account email signs
// in to, as the phone or nuvio.tv/link does. It reports whether there was a
// pending login with that code.
func (s *Server) Approve(userCode, email string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range s.logins {
		if l.userCode == userCode && l.status == "pending" && time.Now().Before(l.expires) {
			l.status, l.user = "approved", UserID(email)
			return true
		}
	}
	return false
}

// UserCodes returns the user code of every pending device login.
func (s *Server) UserCodes() []string {
	s.mu.Lock()
	defer s.mu.Unlock()
	var codes []string
	for _, l := range s.logins {
		if l.status == "pending" {
			codes = append(codes, l.userCode)
		}
	}
	slices.Sort(codes)
	return codes
}

// ExpireDeviceLogins makes every device login not yet exchanged expire, as
// five minutes do.
func (s *Server) ExpireDeviceLogins() {
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, l := range s.logins {
		if l.status != "exchanged" {
			l.status = "expired"
		}
	}
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
	user := ""
	if bearer != nil {
		user = bearer.user
	}
	if s.syncRoutes(w, r, user, body) {
		return
	}

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
		json.NewEncoder(w).Encode(s.profilesOf(bearer.user))
	case "/rest/v1/rpc/sync_pull_profile_locks":
		if bearer == nil {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"code":"42501","message":"permission denied for function sync_pull_profile_locks"}`))
			return
		}
		locks := make([]map[string]any, 0, len(s.profilesOf(bearer.user)))
		for _, p := range s.profilesOf(bearer.user) {
			locks = append(locks, map[string]any{
				"profile_index":    p["profile_index"],
				"pin_enabled":      p["pin_enabled"],
				"pin_locked_until": p["pin_locked_until"],
			})
		}
		json.NewEncoder(w).Encode(locks)
	case "/rest/v1/rpc/verify_profile_pin":
		if bearer == nil {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"code":"42501","message":"permission denied for function verify_profile_pin"}`))
			return
		}
		i, _ := body["p_profile_id"].(float64)
		pin, _ := body["p_pin"].(string)
		// verify_profile_pin returns a table, so PostgREST answers with rows.
		if s.pins[bearer.user][int(i)] == pin {
			json.NewEncoder(w).Encode([]map[string]any{{"unlocked": true, "retry_after_seconds": 0}})
			return
		}
		json.NewEncoder(w).Encode([]map[string]any{{"unlocked": false, "retry_after_seconds": s.PinRetryAfter.Load()}})
	case "/rest/v1/rpc/set_profile_pin", "/rest/v1/rpc/clear_profile_pin":
		if bearer == nil {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"code":"42501","message":"permission denied for function"}`))
			return
		}
		s.pinWrite(w, r.URL.Path, bearer.user, body)
	case "/rest/v1/rpc/sync_patch_profile", "/rest/v1/rpc/sync_push_profiles", "/rest/v1/rpc/sync_delete_profile_data":
		if bearer == nil {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"code":"42501","message":"permission denied for function"}`))
			return
		}
		s.editProfiles(w, r.URL.Path, bearer.user, body)
	case "/rest/v1/rpc/start_device_login_session", "/rest/v1/rpc/poll_tv_login_session", "/functions/v1/tv-logins-exchange":
		s.deviceLogin(w, r.URL.Path, body)
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

// deviceLogin answers the device login calls as NuvioMedia/self-host's
// migration 11 and its tv-logins-exchange function do, and as live did on
// 2026-10-20. s.mu is held.
func (s *Server) deviceLogin(w http.ResponseWriter, path string, body map[string]any) {
	str := func(k string) string { v, _ := body[k].(string); return v }
	switch path {
	case "/rest/v1/rpc/start_device_login_session":
		base := str("p_redirect_base_url")
		if len(strings.TrimSpace(str("p_device_nonce"))) < 12 {
			postgrestError(w, http.StatusBadRequest, "P0001", "Invalid device nonce")
			return
		}
		if !strings.Contains(base, "/link") || !strings.HasPrefix(base, "http") {
			postgrestError(w, http.StatusBadRequest, "P0001", "Invalid device login redirect base URL")
			return
		}
		n := len(s.logins) + 1
		code, user := fmt.Sprintf("device-%d", n), fmt.Sprintf("ABC%03d", n)
		l := &deviceLogin{nonce: str("p_device_nonce"), userCode: user, status: "pending", expires: time.Now().Add(5 * time.Minute)}
		s.logins[code] = l
		json.NewEncoder(w).Encode([]map[string]any{{
			"device_code": code, "user_code": user,
			"verification_uri": base, "verification_uri_complete": base + "?code=" + user,
			"expires_at": l.expires.Format(time.RFC3339Nano), "poll_interval_seconds": 3,
		}})
	case "/rest/v1/rpc/poll_tv_login_session":
		l := s.logins[str("p_code")]
		if l == nil || l.nonce != str("p_device_nonce") {
			postgrestError(w, http.StatusBadRequest, "P0001", "Invalid TV login session")
			return
		}
		if s.FailPolls.Add(-1) >= 0 {
			w.WriteHeader(http.StatusServiceUnavailable)
			return
		}
		json.NewEncoder(w).Encode([]map[string]any{{
			"status": l.status, "expires_at": l.expires.Format(time.RFC3339Nano), "poll_interval_seconds": 3,
		}})
	case "/functions/v1/tv-logins-exchange":
		l := s.logins[str("code")]
		if l == nil || l.nonce != str("device_nonce") || l.status != "approved" {
			w.WriteHeader(http.StatusBadRequest)
			w.Write([]byte(`{"error":"TV login not approved or expired"}`))
			return
		}
		l.status = "exchanged"
		json.NewEncoder(w).Encode(s.issue(&session{user: l.user}))
	}
}

func postgrestError(w http.ResponseWriter, status int, code, msg string) {
	w.WriteHeader(status)
	fmt.Fprintf(w, `{"code":%q,"details":null,"hint":null,"message":%q}`, code, msg)
}

// editProfiles answers the profile writes as the self-host stack did in #95
// (spikes/nuvio-backend/results/local-profiles.json), except that a push
// replaces the list, deleting the profiles it leaves out of slots
// 1..p_client_max_profiles (default 4), as Nuvio documents for live. s.mu is
// held.
func (s *Server) editProfiles(w http.ResponseWriter, path, user string, body map[string]any) {
	list := s.profilesOf(user)
	index := func(v any) int { f, _ := v.(float64); return int(f) }
	find := func(i int) map[string]any {
		for _, p := range list {
			if index(p["profile_index"]) == i {
				return p
			}
		}
		return nil
	}
	switch path {
	case "/rest/v1/rpc/sync_patch_profile":
		i := index(body["p_profile_id"])
		if i < 1 || i > 6 {
			postgrestError(w, http.StatusBadRequest, "22023", "Invalid profile id")
			return
		}
		if name, ok := body["p_name"].(string); ok && strings.TrimSpace(name) == "" {
			postgrestError(w, http.StatusBadRequest, "22023", "Profile name cannot be empty")
			return
		}
		if body["p_avatar_id_provided"] == true && body["p_avatar_id"] != "a1" && body["p_avatar_id"] != "a7" {
			postgrestError(w, http.StatusForbidden, "42501", "This profile avatar is not available on this server")
			return
		}
		p := find(i)
		if p == nil {
			postgrestError(w, http.StatusInternalServerError, "P0002", "Profile not found")
			return
		}
		if name, ok := body["p_name"].(string); ok {
			p["name"] = strings.TrimSpace(name)
		}
		if color, ok := body["p_avatar_color_hex"].(string); ok {
			p["avatar_color_hex"] = color
		}
		if body["p_avatar_id_provided"] == true {
			p["avatar_id"], p["avatar_url"] = body["p_avatar_id"], nil
		}
		json.NewEncoder(w).Encode([]map[string]any{p})
	case "/rest/v1/rpc/sync_push_profiles":
		limit := 4
		if v, ok := body["p_client_max_profiles"]; ok {
			limit = index(v)
		}
		pushed, _ := body["p_profiles"].([]any)
		var next []map[string]any
		for _, p := range list {
			if index(p["profile_index"]) > limit {
				next = append(next, p)
			}
		}
		for _, v := range pushed {
			in, _ := v.(map[string]any)
			i := index(in["profile_index"])
			if i < 1 || i > limit {
				continue
			}
			p := map[string]any{
				"profile_index": in["profile_index"], "name": in["name"], "avatar_color_hex": "#1E88E5",
				"avatar_id": in["avatar_id"], "avatar_url": in["avatar_url"],
				"uses_primary_addons": in["uses_primary_addons"] == true, "uses_primary_plugins": in["uses_primary_plugins"] == true,
				"pin_enabled": false, "pin_locked_until": nil,
			}
			if color, ok := in["avatar_color_hex"].(string); ok {
				p["avatar_color_hex"] = color
			}
			if old := find(i); old != nil {
				p["pin_enabled"] = old["pin_enabled"]
			}
			next = append(next, p)
		}
		slices.SortFunc(next, func(a, b map[string]any) int { return index(a["profile_index"]) - index(b["profile_index"]) })
		s.profiles[user] = next
		w.WriteHeader(http.StatusNoContent)
	case "/rest/v1/rpc/sync_delete_profile_data":
		i := index(body["p_profile_id"])
		s.profiles[user] = slices.DeleteFunc(list, func(p map[string]any) bool { return index(p["profile_index"]) == i })
		w.WriteHeader(http.StatusNoContent)
	}
}

// fourDigits reports whether pin is exactly four digits (0–9), the format
// Nuvio enforces (#25).
func fourDigits(pin string) bool {
	if len(pin) != 4 {
		return false
	}
	for _, r := range pin {
		if r < '0' || r > '9' {
			return false
		}
	}
	return true
}

// pinWrite answers set_profile_pin and clear_profile_pin as the self-host
// stack does (#25): p_current_pin is required to change or remove a PIN the
// profile already has. s.mu is held.
func (s *Server) pinWrite(w http.ResponseWriter, path, user string, body map[string]any) {
	index := func(v any) int { f, _ := v.(float64); return int(f) }
	i := index(body["p_profile_id"])
	if i < 1 || i > 6 {
		postgrestError(w, http.StatusBadRequest, "P0001", "Invalid profile id")
		return
	}
	str := func(k string) string { v, _ := body[k].(string); return v }
	pin, current := str("p_pin"), str("p_current_pin")

	// The profile has a PIN when one is stored or its map says it is enabled.
	stored := s.pins[user][i]
	hasPIN := stored != ""
	if !hasPIN {
		for _, p := range s.profilesOf(user) {
			if index(p["profile_index"]) == i && p["pin_enabled"] == true {
				hasPIN = true
				break
			}
		}
	}

	switch path {
	case "/rest/v1/rpc/set_profile_pin":
		if !fourDigits(pin) {
			postgrestError(w, http.StatusBadRequest, "P0001", "PIN must be exactly 4 digits")
			return
		}
		if hasPIN && current != stored {
			postgrestError(w, http.StatusBadRequest, "P0001", "Current PIN is required to change PIN")
			return
		}
		if s.pins[user] == nil {
			s.pins[user] = map[int]string{}
		}
		s.pins[user][i] = pin
		for _, p := range s.profilesOf(user) {
			if index(p["profile_index"]) == i {
				p["pin_enabled"] = true
				p["pin_locked_until"] = nil
			}
		}
		w.WriteHeader(http.StatusNoContent)
	case "/rest/v1/rpc/clear_profile_pin":
		if hasPIN && current != stored {
			postgrestError(w, http.StatusBadRequest, "P0001", "Current PIN is required to remove PIN")
			return
		}
		delete(s.pins[user], i)
		for _, p := range s.profilesOf(user) {
			if index(p["profile_index"]) == i {
				p["pin_enabled"] = false
				p["pin_locked_until"] = nil
			}
		}
		w.WriteHeader(http.StatusNoContent)
	}
}
