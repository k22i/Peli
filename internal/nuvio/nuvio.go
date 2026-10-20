// Package nuvio talks to a Nuvio backend: api.nuvio.tv or a self-hosted one
// (ADR-0004). It is plain HTTP to Supabase's Auth and PostgREST endpoints, in
// Go so that tokens never reach the webview and refresh can happen in one
// place (ADR-0008). Every call to the backend goes through this package; the
// sync module (#28) builds on it.
//
// The backend's key is not a secret: it is read at runtime from
// GET /.well-known/nuvio, never built in.
package nuvio

import (
	"bytes"
	"cmp"
	"context"
	crand "crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// DefaultURL is Nuvio's hosted backend.
const DefaultURL = "https://api.nuvio.tv"

var (
	// ErrInvalidCredentials means the email or password is wrong.
	ErrInvalidCredentials = errors.New("nuvio: wrong email or password")
	// ErrRateLimited means the backend answered 429 on every attempt.
	ErrRateLimited = errors.New("nuvio: too many requests")
	// ErrUnreachable means the backend couldn't be reached: no network, DNS
	// or a timeout.
	ErrUnreachable = errors.New("nuvio: backend unreachable")
	// ErrUnavailable means the backend answered with a server error.
	ErrUnavailable = errors.New("nuvio: backend unavailable")
	// ErrSignedOut means the session is missing, expired or revoked.
	ErrSignedOut = errors.New("nuvio: signed out")
	// ErrProfileNotFound means the account has no profile at that index:
	// another device deleted it.
	ErrProfileNotFound = errors.New("nuvio: profile not found")
)

// APIError is an error answer the client has no sentinel for.
type APIError struct {
	Status  int
	Code    string
	Message string
}

func (e *APIError) Error() string {
	return fmt.Sprintf("nuvio: HTTP %d %s: %s", e.Status, e.Code, e.Message)
}

// Client calls one Nuvio backend. It is safe for concurrent use.
type Client struct {
	baseURL   string
	userAgent string
	http      *http.Client

	// Retries on 429 after base, 2×base, 4×base…, each with full jitter: the
	// backend sends no Retry-After.
	retries int
	backoff time.Duration
	sleep   func(context.Context, time.Duration) error

	mu  sync.Mutex
	key string
}

// New returns a client for the backend at baseURL. version is Sinag's, for
// the user agent.
func New(baseURL, version string) *Client {
	return &Client{
		baseURL:   strings.TrimRight(baseURL, "/"),
		userAgent: fmt.Sprintf("Sinag/%s (+https://github.com/k22i/Sinag)", version),
		http:      &http.Client{Timeout: 15 * time.Second},
		retries:   2,
		backoff:   time.Second,
		sleep:     sleep,
	}
}

func sleep(ctx context.Context, d time.Duration) error {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-t.C:
		return nil
	case <-ctx.Done():
		return ctx.Err()
	}
}

// Session is a signed-in Supabase session.
type Session struct {
	AccessToken  string
	RefreshToken string
	// When the access token expires, and the account it belongs to, from
	// its claims. Zero if the token can't be read.
	ExpiresAt time.Time
	UserID    string
}

// SessionFromTokens rebuilds a session kept as its two tokens, reading the
// expiry and account from the access token's claims. The token isn't
// verified: the backend does that, and Sinag only needs to know when to
// refresh and whose session it is.
func SessionFromTokens(accessToken, refreshToken string) Session {
	s := Session{AccessToken: accessToken, RefreshToken: refreshToken}
	parts := strings.Split(accessToken, ".")
	if len(parts) != 3 {
		return s
	}
	payload, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return s
	}
	var claims struct {
		Sub string `json:"sub"`
		Exp int64  `json:"exp"`
	}
	if json.Unmarshal(payload, &claims) != nil {
		return s
	}
	if claims.Exp > 0 {
		s.ExpiresAt = time.Unix(claims.Exp, 0)
	}
	s.UserID = claims.Sub
	return s
}

// SignInWithPassword signs in with an email and password.
func (c *Client) SignInWithPassword(ctx context.Context, email, password string) (Session, error) {
	return c.grant(ctx, "password", map[string]string{"email": email, "password": password})
}

// Refresh swaps a refresh token for a new session. Refresh tokens rotate:
// the old one stops working, so keep the new session before anything else.
// A refresh token that no longer works (signed out, revoked or already used)
// gives ErrSignedOut.
func (c *Client) Refresh(ctx context.Context, refreshToken string) (Session, error) {
	s, err := c.grant(ctx, "refresh_token", map[string]string{"refresh_token": refreshToken})
	if errors.Is(err, ErrInvalidCredentials) {
		// Older GoTrue answers a bad refresh token with invalid_grant.
		return Session{}, fmt.Errorf("%w: %v", ErrSignedOut, err)
	}
	return s, err
}

// grant asks GoTrue's token endpoint for a session.
func (c *Client) grant(ctx context.Context, grantType string, in map[string]string) (Session, error) {
	var body struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	err := c.call(ctx, http.MethodPost, "/auth/v1/token?grant_type="+grantType, "", in, &body)
	if err != nil {
		return Session{}, err
	}
	return newSession(body.AccessToken, body.RefreshToken, body.ExpiresIn)
}

// newSession builds a session from a token answer.
func newSession(accessToken, refreshToken string, expiresIn int64) (Session, error) {
	if accessToken == "" || refreshToken == "" {
		return Session{}, errors.New("nuvio: token answer has no session")
	}
	s := SessionFromTokens(accessToken, refreshToken)
	if s.ExpiresAt.IsZero() {
		s.ExpiresAt = time.Now().Add(time.Duration(expiresIn) * time.Second)
	}
	return s, nil
}

// SignOut ends the session on the backend. Other devices stay signed in.
func (c *Client) SignOut(ctx context.Context, s Session) error {
	return c.call(ctx, http.MethodPost, "/auth/v1/logout?scope=local", s.AccessToken, nil, nil)
}

// DefaultLinkURL is Nuvio's "Link a device" page, where a signed-in phone or
// browser approves a device login.
const DefaultLinkURL = "https://nuvio.tv/link"

// ErrDeviceLoginExpired means a device login's code expired, was used, or
// is unknown to the backend: start a new one.
var ErrDeviceLoginExpired = errors.New("nuvio: device login expired")

// DeviceLogin is a sign-in that another device approves, where the account
// is already signed in: it opens URL (from a QR code) or types UserCode at
// LinkURL (#21). The device code and nonce stay on this device; the nonce
// proves the session is the one this device started.
type DeviceLogin struct {
	UserCode  string
	URL       string
	LinkURL   string
	ExpiresAt time.Time
	// How often to poll; never faster, the backend counts polls.
	PollInterval time.Duration

	deviceCode string
	nonce      string
}

// Device login statuses from PollDeviceLogin.
const (
	DeviceLoginPending  = "pending"
	DeviceLoginApproved = "approved"
	DeviceLoginExpired  = "expired"
)

// StartDeviceLogin starts a device login. linkURL is the web page that
// approves it (DefaultLinkURL for api.nuvio.tv), and deviceName is what the
// approving device shows.
func (c *Client) StartDeviceLogin(ctx context.Context, linkURL, deviceName string) (DeviceLogin, error) {
	nonce := make([]byte, 24)
	crand.Read(nonce)
	login := DeviceLogin{nonce: hex.EncodeToString(nonce)}
	var rows []struct {
		DeviceCode   string    `json:"device_code"`
		UserCode     string    `json:"user_code"`
		URI          string    `json:"verification_uri"`
		URIComplete  string    `json:"verification_uri_complete"`
		ExpiresAt    time.Time `json:"expires_at"`
		PollInterval int       `json:"poll_interval_seconds"`
	}
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/start_device_login_session", "", map[string]any{
		"p_device_nonce":      login.nonce,
		"p_redirect_base_url": linkURL,
		"p_device_name":       deviceName,
		"p_device_type":       "desktop",
	}, &rows)
	if err != nil {
		return DeviceLogin{}, err
	}
	if len(rows) == 0 || rows[0].DeviceCode == "" || rows[0].URIComplete == "" {
		return DeviceLogin{}, errors.New("nuvio: device login answer has no code")
	}
	r := rows[0]
	login.deviceCode, login.UserCode = r.DeviceCode, r.UserCode
	login.URL, login.LinkURL, login.ExpiresAt = r.URIComplete, r.URI, r.ExpiresAt
	login.PollInterval = pollInterval(r.PollInterval)
	return login, nil
}

// pollInterval is the backend's interval, or 3 s, as on live, if it gave none.
func pollInterval(seconds int) time.Duration {
	if seconds <= 0 {
		seconds = 3
	}
	return time.Duration(seconds) * time.Second
}

// PollDeviceLogin returns the login's status, DeviceLoginPending until the
// other device approves it, and the interval to poll at next. An unknown
// login gives ErrDeviceLoginExpired.
func (c *Client) PollDeviceLogin(ctx context.Context, login DeviceLogin) (status string, interval time.Duration, err error) {
	var rows []struct {
		Status       string `json:"status"`
		PollInterval int    `json:"poll_interval_seconds"`
	}
	err = c.call(ctx, http.MethodPost, "/rest/v1/rpc/poll_tv_login_session", "", map[string]any{
		"p_code": login.deviceCode, "p_device_nonce": login.nonce,
	}, &rows)
	if apiErr := (*APIError)(nil); errors.As(err, &apiErr) && apiErr.Code == "P0001" {
		// "Invalid TV login session".
		return "", 0, fmt.Errorf("%w: %s", ErrDeviceLoginExpired, apiErr.Message)
	}
	if err != nil {
		return "", 0, err
	}
	if len(rows) == 0 {
		return "", 0, errors.New("nuvio: device login poll answer has no status")
	}
	return rows[0].Status, pollInterval(rows[0].PollInterval), nil
}

// ExchangeDeviceLogin swaps an approved login for a session of the account
// that approved it. It works once: a login that isn't approved, has expired
// or was exchanged already gives ErrDeviceLoginExpired.
func (c *Client) ExchangeDeviceLogin(ctx context.Context, login DeviceLogin) (Session, error) {
	var body struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
	}
	err := c.call(ctx, http.MethodPost, "/functions/v1/tv-logins-exchange", "", map[string]string{
		"code": login.deviceCode, "device_nonce": login.nonce,
	}, &body)
	if apiErr := (*APIError)(nil); errors.As(err, &apiErr) && apiErr.Status == http.StatusBadRequest {
		// The edge function answers 400 for every login it won't exchange.
		return Session{}, fmt.Errorf("%w: %s", ErrDeviceLoginExpired, apiErr.Code)
	}
	if err != nil {
		return Session{}, err
	}
	return newSession(body.AccessToken, body.RefreshToken, body.ExpiresIn)
}

// Profile is a Nuvio profile. Nuvio addresses profiles by index, 1–6.
type Profile struct {
	Index       int     `json:"profile_index"`
	Name        string  `json:"name"`
	AvatarColor string  `json:"avatar_color_hex"`
	AvatarID    *string `json:"avatar_id"`
	AvatarURL   *string `json:"avatar_url"`
	// Secondary profiles can use the primary profile's addons and plugins.
	UsesPrimaryAddons  bool `json:"uses_primary_addons"`
	UsesPrimaryPlugins bool `json:"uses_primary_plugins"`
	PinEnabled         bool `json:"pin_enabled"`
}

// MaxProfiles is how many profiles a Nuvio account can have.
const MaxProfiles = 6

// Profiles returns the account's profiles.
func (c *Client) Profiles(ctx context.Context, s Session) ([]Profile, error) {
	profiles := []Profile{}
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_pull_profiles", s.AccessToken,
		map[string]any{}, &profiles)
	return profiles, err
}

// ProfilePatch is a change to one profile: nil fields are kept.
type ProfilePatch struct {
	Name        *string
	AvatarColor *string
	// A stock avatar from AvatarCatalog. Setting it clears a custom avatar
	// URL. An ID that isn't in the catalog is refused with 42501, which reads
	// as ErrSignedOut, so only send IDs from the catalog.
	AvatarID *string
}

// PatchProfile changes one profile and leaves the rest of it, and the other
// profiles, as they are. It returns the profile after the change, or
// ErrProfileNotFound if there's none at index.
func (c *Client) PatchProfile(ctx context.Context, s Session, index int, patch ProfilePatch) (Profile, error) {
	in := map[string]any{"p_profile_id": index}
	if patch.Name != nil {
		in["p_name"] = *patch.Name
	}
	if patch.AvatarColor != nil {
		in["p_avatar_color_hex"] = *patch.AvatarColor
	}
	if patch.AvatarID != nil {
		in["p_avatar_id"] = *patch.AvatarID
		in["p_avatar_id_provided"] = true
	}
	var rows []Profile
	if err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_patch_profile", s.AccessToken, in, &rows); err != nil {
		return Profile{}, err
	}
	if len(rows) == 0 {
		return Profile{}, ErrProfileNotFound
	}
	return rows[0], nil
}

// PushProfiles saves profiles, adding those at a new index. Pass every
// profile, freshly pulled, with every field: live is documented to delete
// the profiles a push leaves out, and a push resets the fields it isn't sent
// (docs/spikes/nuvio-backend.md). PIN fields are never touched.
func (c *Client) PushProfiles(ctx context.Context, s Session, profiles []Profile) error {
	rows := make([]map[string]any, len(profiles))
	for i, p := range profiles {
		avatarID := p.AvatarID
		if p.AvatarURL != nil {
			// A custom URL wins over a stock avatar, as Nuvio's dashboard sends it.
			avatarID = nil
		}
		rows[i] = map[string]any{
			"profile_index":        p.Index,
			"name":                 p.Name,
			"avatar_color_hex":     p.AvatarColor,
			"uses_primary_addons":  p.UsesPrimaryAddons,
			"uses_primary_plugins": p.UsesPrimaryPlugins,
			"avatar_id":            avatarID,
			"avatar_url":           p.AvatarURL,
		}
	}
	return c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_push_profiles", s.AccessToken,
		map[string]any{"p_profiles": rows, "p_client_max_profiles": MaxProfiles}, nil)
}

// DeleteProfile deletes the profile at index and everything in it on every
// device: library, progress, watched items, addons and settings. The backend
// lets any profile go, the primary and the last one too, so callers decide
// which may.
func (c *Client) DeleteProfile(ctx context.Context, s Session, index int) error {
	return c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_delete_profile_data", s.AccessToken,
		map[string]any{"p_profile_id": index}, nil)
}

// Avatar is one of the backend's stock profile avatars: a profile's
// avatar_id names one.
type Avatar struct {
	ID    string `json:"id"`
	Name  string `json:"display_name"`
	Path  string `json:"storage_path"`
	Color string `json:"bg_color"`
}

// AvatarCatalog returns the stock avatars. It is public: it needs no session.
func (c *Client) AvatarCatalog(ctx context.Context) ([]Avatar, error) {
	avatars := []Avatar{}
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/get_avatar_catalog", "", map[string]any{}, &avatars)
	return avatars, err
}

// AvatarImageURL returns where a stock avatar's image is: its storage path
// in the backend's public "avatars" bucket, as seen on live (#24).
func (c *Client) AvatarImageURL(a Avatar) string {
	segments := strings.Split(a.Path, "/")
	for i, segment := range segments {
		segments[i] = url.PathEscape(segment)
	}
	return c.baseURL + "/storage/v1/object/public/avatars/" + strings.Join(segments, "/")
}

// publishableKey returns the backend's public key, reading the discovery
// document once.
func (c *Client) publishableKey(ctx context.Context) (string, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.key != "" {
		return c.key, nil
	}
	var doc struct {
		Service        string `json:"service"`
		PublishableKey string `json:"publishable_key"`
	}
	if err := c.do(ctx, http.MethodGet, "/.well-known/nuvio", nil, nil, &doc); err != nil {
		return "", err
	}
	if doc.Service != "nuvio" || doc.PublishableKey == "" {
		return "", fmt.Errorf("nuvio: %s is not a Nuvio backend", c.baseURL)
	}
	c.key = doc.PublishableKey
	return c.key, nil
}

// call makes an authenticated request: the publishable key as apikey, and
// the session's access token, if any, as the bearer.
func (c *Client) call(ctx context.Context, method, path, accessToken string, in, out any) error {
	key, err := c.publishableKey(ctx)
	if err != nil {
		return err
	}
	header := http.Header{"Apikey": {key}}
	if accessToken == "" {
		accessToken = key
	}
	header.Set("Authorization", "Bearer "+accessToken)
	return c.do(ctx, method, path, header, in, out)
}

// do sends a request, retrying on 429, and decodes a 2xx JSON answer into out.
func (c *Client) do(ctx context.Context, method, path string, header http.Header, in, out any) error {
	var body []byte
	if in != nil {
		var err error
		if body, err = json.Marshal(in); err != nil {
			return err
		}
	}
	for attempt := 0; ; attempt++ {
		err := c.once(ctx, method, path, header, body, out)
		if !errors.Is(err, ErrRateLimited) || attempt == c.retries {
			return err
		}
		wait := rand.N(c.backoff << attempt)
		if err := c.sleep(ctx, wait); err != nil {
			return err
		}
	}
}

func (c *Client) once(ctx context.Context, method, path string, header http.Header, body []byte, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(body))
	if err != nil {
		return err
	}
	for k, v := range header {
		req.Header[k] = v
	}
	req.Header.Set("User-Agent", c.userAgent)
	req.Header.Set("Accept", "application/json")
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}

	res, err := c.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	if err != nil {
		return fmt.Errorf("%w: %v", ErrUnreachable, err)
	}

	if res.StatusCode >= 300 {
		return answerError(res, data)
	}
	if out == nil || len(bytes.TrimSpace(data)) == 0 {
		return nil
	}
	if err := json.Unmarshal(data, out); err != nil {
		return fmt.Errorf("nuvio: %s %s: %w", method, strings.SplitN(path, "?", 2)[0], err)
	}
	return nil
}

// answerError maps an error answer from Auth (GoTrue) or PostgREST onto the
// package's errors.
func answerError(res *http.Response, data []byte) error {
	var body struct {
		// GoTrue: error_code and msg; older GoTrue: error and
		// error_description. PostgREST: code and message.
		ErrorCode        string          `json:"error_code"`
		Msg              string          `json:"msg"`
		Error            string          `json:"error"`
		ErrorDescription string          `json:"error_description"`
		Code             json.RawMessage `json:"code"`
		Message          string          `json:"message"`
	}
	json.Unmarshal(data, &body)
	code := cmp.Or(res.Header.Get("X-Sb-Error-Code"), body.ErrorCode, body.Error)
	if code == "" {
		// PostgREST's code is a string; GoTrue's is the HTTP status.
		json.Unmarshal(body.Code, &code)
	}
	message := cmp.Or(body.Msg, body.ErrorDescription, body.Message, http.StatusText(res.StatusCode))

	switch {
	case res.StatusCode == http.StatusTooManyRequests:
		return ErrRateLimited
	case code == "invalid_credentials" || code == "invalid_grant":
		return ErrInvalidCredentials
	// sync_patch_profile raises it with HTTP 500.
	case code == "P0002":
		return fmt.Errorf("%w: %s", ErrProfileNotFound, message)
	// No session, an expired or forged token, or a revoked session. Live and
	// self-host disagree on the code, so take any of them. GoTrue's codes
	// are for a refresh token that stopped working.
	case code == "42501" || code == "28000" || code == "PGRST301" || res.StatusCode == http.StatusUnauthorized,
		code == "refresh_token_not_found" || code == "refresh_token_already_used",
		code == "session_not_found" || code == "session_expired":
		return fmt.Errorf("%w: %s", ErrSignedOut, message)
	case res.StatusCode >= 500:
		return fmt.Errorf("%w: HTTP %d", ErrUnavailable, res.StatusCode)
	}
	return &APIError{Status: res.StatusCode, Code: code, Message: message}
}
