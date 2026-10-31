// Package simkl is Sinag's client for SIMKL's API (api.simkl.org): AUTH V2
// device sign-in and token refresh, scrobbling, and the watched history
// (#72–#74). Only internal/tracking calls it. See ADR-0042.
package simkl

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"time"
)

// DefaultURL is SIMKL's API.
const DefaultURL = "https://api.simkl.com"

// AppName is what SIMKL's request log calls Sinag (the app-name parameter).
const AppName = "sinag"

// Scope is what Sinag asks for: reading the history, and writing scrobbles.
// SIMKL turns a scope it doesn't know into read-only without saying so, so
// the token's scope is checked after sign-in.
const Scope = "media:read media:write"

var (
	// ErrUnauthorized means the access token is no longer good: refresh it,
	// or connect again if refreshing fails too.
	ErrUnauthorized = errors.New("simkl: not authorized")
	// ErrNotFound means SIMKL couldn't match the title (id_err).
	ErrNotFound = errors.New("simkl: title not found")
	// ErrAlreadyDone is a 409 on a stop: SIMKL finalized that session in
	// the last hour, so the watch is already recorded.
	ErrAlreadyDone = errors.New("simkl: already scrobbled")
	// ErrUnreachable means SIMKL couldn't be reached at all.
	ErrUnreachable = errors.New("simkl: unreachable")
	// ErrUnavailable means SIMKL answered with a server error.
	ErrUnavailable = errors.New("simkl: unavailable")
	// ErrNoClientID means this build has no SIMKL app to connect with.
	ErrNoClientID = errors.New("simkl: no client id")
	// ErrReadOnly means the token can't write, so it can't scrobble.
	ErrReadOnly = errors.New("simkl: token is read-only")

	// Device sign-in: not approved yet, polled too fast, the code expired.
	ErrPending   = errors.New("simkl: authorization pending")
	ErrSlowDown  = errors.New("simkl: slow down")
	ErrCodeGone  = errors.New("simkl: device code expired")
	errAppRefuse = errors.New("simkl: client refused")
)

// RateLimited is a 429. RetryAfter is 0 for the per-second limit, which
// clears at once; otherwise it's how long the user's daily allowance lasts.
type RateLimited struct{ RetryAfter time.Duration }

func (e *RateLimited) Error() string {
	return fmt.Sprintf("simkl: rate limited, retry after %s", e.RetryAfter)
}

// Temporary reports whether err may go away by itself: offline, SIMKL down,
// or rate limited. Such calls are worth queuing and trying again.
func Temporary(err error) bool {
	var limited *RateLimited
	return errors.Is(err, ErrUnreachable) || errors.Is(err, ErrUnavailable) || errors.As(err, &limited)
}

// Client calls SIMKL as one app (clientID). It holds no user token: each
// user call takes one.
type Client struct {
	base     string
	clientID string
	version  string
	http     *http.Client
}

// New returns a client for SIMKL's API at base, as the app clientID, sending
// version as Sinag's.
func New(base, clientID, version string) *Client {
	return &Client{
		base:     strings.TrimSuffix(base, "/"),
		clientID: clientID,
		version:  version,
		http:     &http.Client{Timeout: 30 * time.Second},
	}
}

// Configured reports whether the client has an app to call SIMKL as.
func (c *Client) Configured() bool { return c.clientID != "" }

// --- sign-in (AUTH V2 device flow) -------------------------------------------

// DeviceCode is a pending device sign-in. DeviceCode itself is the
// credential polled with: never shown or logged.
type DeviceCode struct {
	DeviceCode string `json:"device_code"`
	UserCode   string `json:"user_code"`
	// The approval page, and the same with the code filled in.
	VerificationURI         string `json:"verification_uri"`
	VerificationURIComplete string `json:"verification_uri_complete"`
	ExpiresIn               int    `json:"expires_in"`
	Interval                int    `json:"interval"`
}

// Token is a grant: the access token (7 days) and the refresh token (180
// days, sliding).
type Token struct {
	AccessToken  string `json:"access_token"`
	RefreshToken string `json:"refresh_token"`
	ExpiresIn    int    `json:"expires_in"`
	Scope        string `json:"scope"`
}

// CanWrite reports whether the token may scrobble.
func (t Token) CanWrite() bool {
	return strings.Contains(" "+t.Scope+" ", " media:write ")
}

// StartDevice asks for a device code for the user to approve.
func (c *Client) StartDevice(ctx context.Context) (DeviceCode, error) {
	var code DeviceCode
	err := c.form(ctx, "/oauth2/device", url.Values{"scope": {Scope}}, &code)
	return code, err
}

// PollDevice asks whether the user approved code. Until they do it fails
// with ErrPending (or ErrSlowDown: wait 5 s longer); ErrCodeGone means
// start again.
func (c *Client) PollDevice(ctx context.Context, deviceCode string) (Token, error) {
	var token Token
	err := c.form(ctx, "/oauth2/token", url.Values{
		"grant_type":  {"urn:ietf:params:oauth:grant-type:device_code"},
		"device_code": {deviceCode},
	}, &token)
	return token, err
}

// Refresh gets a new access token for the grant. The refresh token comes
// back the same.
func (c *Client) Refresh(ctx context.Context, refreshToken string) (Token, error) {
	var token Token
	err := c.form(ctx, "/oauth2/token", url.Values{
		"grant_type":    {"refresh_token"},
		"refresh_token": {refreshToken},
	}, &token)
	return token, err
}

// Revoke ends the grant token belongs to. SIMKL answers 200 whatever
// happened, so there is nothing to check.
func (c *Client) Revoke(ctx context.Context, token string) error {
	return c.form(ctx, "/oauth2/revoke", url.Values{"token": {token}}, nil)
}

// form posts an OAuth form. OAuth answers errors as {"error": "..."}.
func (c *Client) form(ctx context.Context, path string, values url.Values, out any) error {
	if !c.Configured() {
		return ErrNoClientID
	}
	values.Set("client_id", c.clientID)
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base+path, strings.NewReader(values.Encode()))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	return c.do(req, out)
}

// --- the user --------------------------------------------------------------

// User is who a token belongs to.
type User struct {
	User struct {
		Name   string `json:"name"`
		Avatar string `json:"avatar"`
	} `json:"user"`
	Account struct {
		ID   int64  `json:"id"`
		Type string `json:"type"`
	} `json:"account"`
}

// Settings returns the token's user.
func (c *Client) Settings(ctx context.Context, token string) (User, error) {
	var user User
	err := c.call(ctx, token, http.MethodGet, "/users/settings", nil, nil, &user)
	return user, err
}

// --- scrobbling (#73) ----------------------------------------------------------

// IDs are a title's ids, by SIMKL's key names (imdb, tmdb, tvdb, mal,
// anidb, anilist, kitsu). Every one is a string.
type IDs map[string]string

// Media names a film, show or anime.
type Media struct {
	Title string `json:"title,omitempty"`
	Year  int    `json:"year,omitempty"`
	IDs   IDs    `json:"ids"`
}

// Episode is an episode by season and number; anime-native ids leave the
// season out.
type Episode struct {
	Season *int `json:"season,omitempty"`
	Number int  `json:"number"`
}

// Item is what a scrobble is about: a movie, or a show or anime and one of
// its episodes.
type Item struct {
	Movie   *Media   `json:"movie,omitempty"`
	Show    *Media   `json:"show,omitempty"`
	Anime   *Media   `json:"anime,omitempty"`
	Episode *Episode `json:"episode,omitempty"`
}

// Scrobble actions.
const (
	ActionStart = "start"
	ActionPause = "pause"
	ActionStop  = "stop"
)

// Scrobbled is SIMKL's answer: "start", "pause", or "scrobble" when a stop
// marked it watched.
type Scrobbled struct {
	Action   string  `json:"action"`
	Progress float64 `json:"progress"`
}

// Scrobble sends a start, pause or stop for item at progress (0–100).
// minProgress is where a stop turns into watched (SIMKL's default is 80);
// it's sent on every call, so they all agree. A stop SIMKL already
// finalized fails with ErrAlreadyDone.
func (c *Client) Scrobble(ctx context.Context, token, action string, item Item, progress float64, minProgress int) (Scrobbled, error) {
	body := struct {
		Item
		Progress float64 `json:"progress"`
	}{item, roundProgress(progress)}
	query := url.Values{}
	if minProgress > 0 {
		query.Set("min_progress", strconv.Itoa(minProgress))
	}
	var out Scrobbled
	err := c.call(ctx, token, http.MethodPost, "/scrobble/"+action, query, body, &out)
	return out, err
}

// roundProgress keeps two decimals, which is all SIMKL takes.
func roundProgress(p float64) float64 {
	p = min(max(p, 0), 100)
	return float64(int(p*100+0.5)) / 100
}

// --- history (#74) -------------------------------------------------------------

// History is a batch for /sync/history: watched films, and shows or anime
// with the episodes watched.
type History struct {
	Movies []HistoryItem `json:"movies,omitempty"`
	Shows  []HistoryItem `json:"shows,omitempty"`
	Anime  []HistoryItem `json:"anime,omitempty"`
}

// HistoryItem is a film watched at WatchedAt, or a show's episodes.
type HistoryItem struct {
	Media
	WatchedAt string          `json:"watched_at,omitempty"`
	Seasons   []HistorySeason `json:"seasons,omitempty"`
	Episodes  []HistoryEp     `json:"episodes,omitempty"`
	// TVDBSeasons says Seasons are TVDB's (Cinemeta's), for a show SIMKL
	// keeps as anime; SIMKL reads them as AniDB's otherwise.
	TVDBSeasons bool `json:"use_tvdb_anime_seasons,omitempty"`
}

// HistorySeason is a season's watched episodes.
type HistorySeason struct {
	Number   int         `json:"number"`
	Episodes []HistoryEp `json:"episodes"`
}

// HistoryEp is an episode watched at WatchedAt.
type HistoryEp struct {
	Number    int    `json:"number"`
	WatchedAt string `json:"watched_at,omitempty"`
}

// AddHistory records watches, as a scrobble's stop would have.
func (c *Client) AddHistory(ctx context.Context, token string, history History) error {
	return c.call(ctx, token, http.MethodPost, "/sync/history", nil, history, nil)
}

// Activities are the user's lists' last-changed times. Only the parts Sinag
// reads are kept; All moves whenever anything does.
type Activities struct {
	All     string        `json:"all"`
	TVShows ActivityGroup `json:"tv_shows"`
	Anime   ActivityGroup `json:"anime"`
	Movies  ActivityGroup `json:"movies"`
}

// ActivityGroup is one type's times.
type ActivityGroup struct {
	All             string `json:"all"`
	RemovedFromList string `json:"removed_from_list"`
}

// Activities returns when each of the user's lists last changed.
func (c *Client) Activities(ctx context.Context, token string) (Activities, error) {
	var out Activities
	err := c.call(ctx, token, http.MethodGet, "/sync/activities", nil, nil, &out)
	return out, err
}

// Library is the user's lists, or what changed in them.
type Library struct {
	Movies []LibraryItem `json:"movies"`
	Shows  []LibraryItem `json:"shows"`
	Anime  []LibraryItem `json:"anime"`
}

// LibraryItem is one title in a list. Movie is set for films, Show for shows
// and anime. Seasons come with extended=full.
type LibraryItem struct {
	Status        string  `json:"status"`
	LastWatchedAt *string `json:"last_watched_at"`
	// An anime's kind: "tv", "movie", "ova"…
	AnimeType string          `json:"anime_type"`
	Movie     *LibraryMedia   `json:"movie"`
	Show      *LibraryMedia   `json:"show"`
	Seasons   []LibrarySeason `json:"seasons"`
}

// LibraryMedia is a listed title. SIMKL sends its own id as a number and
// every other as a string.
type LibraryMedia struct {
	Title string         `json:"title"`
	Year  int            `json:"year"`
	IDs   map[string]any `json:"ids"`
}

// ID returns the id named key as a string, or "".
func (m LibraryMedia) ID(key string) string {
	switch v := m.IDs[key].(type) {
	case string:
		return v
	case float64:
		return strconv.FormatInt(int64(v), 10)
	}
	return ""
}

// LibrarySeason is a season's episodes. For anime with
// extended=full_anime_seasons, each episode also says where it falls in
// TVDB's numbering.
type LibrarySeason struct {
	Number   int              `json:"number"`
	Episodes []LibraryEpisode `json:"episodes"`
}

// LibraryEpisode is a watched episode.
type LibraryEpisode struct {
	Number    int     `json:"number"`
	WatchedAt *string `json:"watched_at"`
	TVDB      *struct {
		Season  int `json:"season"`
		Episode int `json:"episode"`
	} `json:"tvdb"`
}

// WatchedLibrary returns the user's watched films and episodes of kind
// ("movies", "shows" or "anime"), only those changed after since (SIMKL's
// own timestamp, as Activities gave it) unless since is "".
func (c *Client) WatchedLibrary(ctx context.Context, token, kind, since string) (Library, error) {
	query := url.Values{"extended": {"full"}, "episode_watched_at": {"yes"}, "include_all_episodes": {"yes"}}
	if kind == "anime" {
		query.Set("extended", "full_anime_seasons")
	}
	if since != "" {
		query.Set("date_from", since)
	}
	var out Library
	err := c.call(ctx, token, http.MethodGet, "/sync/all-items/"+kind, query, nil, &out)
	return out, err
}

// --- the wire ------------------------------------------------------------------

func (c *Client) call(ctx context.Context, token, method, path string, query url.Values, body, out any) error {
	if !c.Configured() {
		return ErrNoClientID
	}
	if query == nil {
		query = url.Values{}
	}
	query.Set("client_id", c.clientID)
	query.Set("app-name", AppName)
	query.Set("app-version", c.version)
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	req, err := http.NewRequestWithContext(ctx, method, c.base+path+"?"+query.Encode(), reader)
	if err != nil {
		return err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	return c.do(req, out)
}

func (c *Client) do(req *http.Request, out any) error {
	req.Header.Set("User-Agent", AppName+"/"+c.version)
	req.Header.Set("Accept", "application/json")
	res, err := c.http.Do(req)
	if err != nil {
		if ctxErr := req.Context().Err(); ctxErr != nil {
			return ctxErr
		}
		return fmt.Errorf("%w: %w", ErrUnreachable, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return fmt.Errorf("%w: %w", ErrUnreachable, err)
	}
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		if out == nil || len(bytes.TrimSpace(data)) == 0 {
			return nil
		}
		if err := json.Unmarshal(data, out); err != nil {
			return fmt.Errorf("%w: %w", ErrUnavailable, err)
		}
		return nil
	}
	return statusErr(res, data)
}

// statusErr turns a failed answer into one of the package's errors. The
// body never holds a token, but it's still not logged in full.
func statusErr(res *http.Response, data []byte) error {
	var body struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	_ = json.Unmarshal(data, &body)
	switch {
	case body.Error == "authorization_pending":
		return ErrPending
	case body.Error == "slow_down":
		return ErrSlowDown
	case body.Error == "expired_token":
		return ErrCodeGone
	case body.Error == "invalid_client":
		return fmt.Errorf("%w: %s", errAppRefuse, body.Message)
	case body.Error == "invalid_grant", res.StatusCode == http.StatusUnauthorized:
		return ErrUnauthorized
	case res.StatusCode == http.StatusNotFound:
		return ErrNotFound
	case res.StatusCode == http.StatusConflict:
		return ErrAlreadyDone
	case res.StatusCode == http.StatusTooManyRequests:
		limited := &RateLimited{}
		if body.Error != "rate_limit" {
			if seconds, err := strconv.Atoi(res.Header.Get("Retry-After")); err == nil {
				limited.RetryAfter = time.Duration(seconds) * time.Second
			}
		}
		return limited
	case res.StatusCode >= 500:
		return fmt.Errorf("%w: HTTP %d", ErrUnavailable, res.StatusCode)
	}
	return fmt.Errorf("simkl: HTTP %d %s", res.StatusCode, body.Error)
}
