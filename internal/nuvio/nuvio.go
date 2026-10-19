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
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math/rand/v2"
	"net/http"
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
	if body.AccessToken == "" || body.RefreshToken == "" {
		return Session{}, errors.New("nuvio: token answer has no session")
	}
	s := SessionFromTokens(body.AccessToken, body.RefreshToken)
	if s.ExpiresAt.IsZero() {
		s.ExpiresAt = time.Now().Add(time.Duration(body.ExpiresIn) * time.Second)
	}
	return s, nil
}

// SignOut ends the session on the backend. Other devices stay signed in.
func (c *Client) SignOut(ctx context.Context, s Session) error {
	return c.call(ctx, http.MethodPost, "/auth/v1/logout?scope=local", s.AccessToken, nil, nil)
}

// Profile is a Nuvio profile. Nuvio addresses profiles by index, 1–6.
type Profile struct {
	Index       int     `json:"profile_index"`
	Name        string  `json:"name"`
	AvatarColor string  `json:"avatar_color_hex"`
	AvatarID    string  `json:"avatar_id"`
	AvatarURL   *string `json:"avatar_url"`
	PinEnabled  bool    `json:"pin_enabled"`
}

// Profiles returns the account's profiles.
func (c *Client) Profiles(ctx context.Context, s Session) ([]Profile, error) {
	profiles := []Profile{}
	err := c.call(ctx, http.MethodPost, "/rest/v1/rpc/sync_pull_profiles", s.AccessToken,
		map[string]any{}, &profiles)
	return profiles, err
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
