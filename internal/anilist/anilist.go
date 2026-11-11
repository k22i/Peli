// Package anilist is Peli's client for AniList's GraphQL API
// (docs.anilist.co): who a token belongs to, finding anime, and the user's
// list (#104, #105), called by internal/tracking. internal/anilistaddon
// asks it for lists and details with Public (#108). See ADR-0042, ADR-0045.
package anilist

import (
	"bytes"
	"context"
	"encoding/base64"
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

// DefaultURL is AniList's GraphQL endpoint.
const DefaultURL = "https://graphql.anilist.co"

// AuthorizeBase is where the user approves Peli. AniList's implicit grant
// sends the token back in the redirect's fragment.
const AuthorizeBase = "https://anilist.co/api/v2/oauth/authorize"

var (
	// ErrUnauthorized means the token expired or was revoked. AniList tokens
	// don't refresh: the user connects again.
	ErrUnauthorized = errors.New("anilist: not authorized")
	ErrUnreachable  = errors.New("anilist: unreachable")
	ErrUnavailable  = errors.New("anilist: unavailable")
	ErrNotFound     = errors.New("anilist: not found")
)

// RateLimited is a 429: AniList allows 90 requests a minute (30 while
// degraded), then times out for a minute.
type RateLimited struct{ RetryAfter time.Duration }

func (e *RateLimited) Error() string {
	return fmt.Sprintf("anilist: rate limited, retry after %s", e.RetryAfter)
}

// Temporary reports whether err may go away by itself.
func Temporary(err error) bool {
	var limited *RateLimited
	return errors.Is(err, ErrUnreachable) || errors.Is(err, ErrUnavailable) || errors.As(err, &limited)
}

// AuthorizeURL is the page that asks the user to let app clientID at their
// list.
func AuthorizeURL(clientID string) string {
	return AuthorizeBase + "?" + url.Values{"client_id": {clientID}, "response_type": {"token"}}.Encode()
}

// Expiry reads when token expires from its JWT claims (AniList's last a
// year). It's zero if the token doesn't say.
func Expiry(token string) time.Time {
	parts := strings.Split(token, ".")
	if len(parts) != 3 {
		return time.Time{}
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil {
		return time.Time{}
	}
	var claims struct {
		Exp json.Number `json:"exp"`
	}
	if json.Unmarshal(data, &claims) != nil {
		return time.Time{}
	}
	exp, err := claims.Exp.Float64()
	if err != nil || exp <= 0 {
		return time.Time{}
	}
	return time.Unix(int64(exp), 0)
}

// Client calls AniList.
type Client struct {
	base    string
	version string
	http    *http.Client
}

// New returns a client for AniList's API at base.
func New(base, version string) *Client {
	return &Client{base: base, version: version, http: &http.Client{Timeout: 30 * time.Second}}
}

// User is who a token belongs to.
type User struct {
	ID   int    `json:"id"`
	Name string `json:"name"`
}

// Viewer returns token's user.
func (c *Client) Viewer(ctx context.Context, token string) (User, error) {
	var out struct {
		Viewer User `json:"Viewer"`
	}
	err := c.query(ctx, token, `query { Viewer { id name } }`, nil, &out)
	return out.Viewer, err
}

// Media is an anime: one entry per season or cour.
type Media struct {
	ID       int    `json:"id"`
	IDMal    *int   `json:"idMal"`
	Episodes *int   `json:"episodes"`
	Format   string `json:"format"`
	// Only asked for with ListByStatus.
	Title *struct {
		Romaji  string `json:"romaji"`
		English string `json:"english"`
	} `json:"title"`
	CoverImage *struct {
		Large string `json:"large"`
	} `json:"coverImage"`
	StartDate *struct {
		Year *int `json:"year"`
	} `json:"startDate"`
	// The user's entry, when asked with their token.
	Entry *Entry `json:"mediaListEntry"`
}

// Entry is a list entry's state.
type Entry struct {
	ID       int    `json:"id"`
	Status   string `json:"status"`
	Progress int    `json:"progress"`
	// The user's score out of 100, whatever format they keep it in; 0 for none.
	Score int `json:"score"`
}

// List statuses.
const (
	StatusPlanning  = "PLANNING"
	StatusCurrent   = "CURRENT"
	StatusCompleted = "COMPLETED"
	StatusPaused    = "PAUSED"
	StatusDropped   = "DROPPED"
	StatusRepeating = "REPEATING"
)

const mediaFields = `id idMal episodes format`

// ByMAL finds the anime with MyAnimeList id mal.
func (c *Client) ByMAL(ctx context.Context, mal int) (Media, error) {
	var out struct {
		Media *Media `json:"Media"`
	}
	err := c.query(ctx, "", `query ($mal: Int) { Media(idMal: $mal, type: ANIME) { `+mediaFields+` } }`,
		map[string]any{"mal": mal}, &out)
	if err == nil && out.Media == nil {
		err = ErrNotFound
	}
	if err != nil {
		return Media{}, err
	}
	return *out.Media, nil
}

// WithEntry returns anime id with token's user's entry for it (nil if it's
// not on their list).
func (c *Client) WithEntry(ctx context.Context, token string, id int) (Media, error) {
	var out struct {
		Media *Media `json:"Media"`
	}
	err := c.query(ctx, token, `query ($id: Int) { Media(id: $id, type: ANIME) { `+mediaFields+` mediaListEntry { id status progress score(format: POINT_100) } } }`,
		map[string]any{"id": id}, &out)
	if err == nil && out.Media == nil {
		err = ErrNotFound
	}
	if err != nil {
		return Media{}, err
	}
	return *out.Media, nil
}

// SaveProgress sets the user's entry for anime id to progress episodes
// watched, with status.
func (c *Client) SaveProgress(ctx context.Context, token string, id, progress int, status string) error {
	return c.query(ctx, token,
		`mutation ($id: Int, $progress: Int, $status: MediaListStatus) { SaveMediaListEntry(mediaId: $id, progress: $progress, status: $status) { id } }`,
		map[string]any{"id": id, "progress": progress, "status": status}, nil)
}

// SaveStatus puts anime id on the user's list with status, leaving its
// progress and score as they are.
func (c *Client) SaveStatus(ctx context.Context, token string, id int, status string) error {
	return c.query(ctx, token,
		`mutation ($id: Int, $status: MediaListStatus) { SaveMediaListEntry(mediaId: $id, status: $status) { id } }`,
		map[string]any{"id": id, "status": status}, nil)
}

// SaveScore sets the user's score for anime id out of 100 (AniList converts
// it to the format they keep); 0 clears it.
func (c *Client) SaveScore(ctx context.Context, token string, id, score int) error {
	return c.query(ctx, token,
		`mutation ($id: Int, $score: Int) { SaveMediaListEntry(mediaId: $id, scoreRaw: $score) { id } }`,
		map[string]any{"id": id, "score": score}, nil)
}

// DeleteEntry takes the list entry entryID (an Entry's ID, not the anime's)
// off the user's list.
func (c *Client) DeleteEntry(ctx context.Context, token string, entryID int) error {
	return c.query(ctx, token,
		`mutation ($id: Int) { DeleteMediaListEntry(id: $id) { deleted } }`,
		map[string]any{"id": entryID}, nil)
}

// ListByStatus returns user's anime with status, with the titles and covers
// to show them.
func (c *Client) ListByStatus(ctx context.Context, token string, user int, status string) ([]ListEntry, error) {
	var out struct {
		Collection struct {
			Lists []struct {
				Entries []ListEntry `json:"entries"`
			} `json:"lists"`
		} `json:"MediaListCollection"`
	}
	err := c.query(ctx, token,
		`query ($user: Int, $status: MediaListStatus) { MediaListCollection(userId: $user, type: ANIME, status: $status) { lists { entries { status progress updatedAt media { `+mediaFields+` title { romaji english } coverImage { large } startDate { year } } } } } }`,
		map[string]any{"user": user, "status": status}, &out)
	if err != nil {
		return nil, err
	}
	var entries []ListEntry
	for _, list := range out.Collection.Lists {
		entries = append(entries, list.Entries...)
	}
	return entries, nil
}

// ListEntry is an anime on the user's list.
type ListEntry struct {
	Status    string `json:"status"`
	Progress  int    `json:"progress"`
	UpdatedAt int64  `json:"updatedAt"`
	// When it was completed; zero parts when not.
	CompletedAt struct {
		Year  *int `json:"year"`
		Month *int `json:"month"`
		Day   *int `json:"day"`
	} `json:"completedAt"`
	Media Media `json:"media"`
}

// List returns user's anime list, every status.
func (c *Client) List(ctx context.Context, token string, user int) ([]ListEntry, error) {
	var out struct {
		Collection struct {
			Lists []struct {
				Entries []ListEntry `json:"entries"`
			} `json:"lists"`
		} `json:"MediaListCollection"`
	}
	err := c.query(ctx, token,
		`query ($user: Int) { MediaListCollection(userId: $user, type: ANIME) { lists { entries { status progress updatedAt completedAt { year month day } media { `+mediaFields+` } } } } }`,
		map[string]any{"user": user}, &out)
	if err != nil {
		return nil, err
	}
	var entries []ListEntry
	for _, list := range out.Collection.Lists {
		entries = append(entries, list.Entries...)
	}
	return entries, nil
}

// Public runs a query that needs no token, such as AniList's lists and a
// title's details, and decodes its data into out.
func (c *Client) Public(ctx context.Context, query string, variables map[string]any, out any) error {
	return c.query(ctx, "", query, variables, out)
}

func (c *Client) query(ctx context.Context, token, query string, variables map[string]any, out any) error {
	data, err := json.Marshal(map[string]any{"query": query, "variables": variables})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.base, bytes.NewReader(data))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "Peli/"+c.version+" (+https://github.com/k22i/Peli)")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	res, err := c.http.Do(req)
	if err != nil {
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		return fmt.Errorf("%w: %w", ErrUnreachable, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 32<<20))
	if err != nil {
		return fmt.Errorf("%w: %w", ErrUnreachable, err)
	}
	var answer struct {
		Data   json.RawMessage `json:"data"`
		Errors []struct {
			Message string `json:"message"`
			Status  int    `json:"status"`
		} `json:"errors"`
	}
	_ = json.Unmarshal(body, &answer)
	status := res.StatusCode
	for _, e := range answer.Errors {
		if e.Status != 0 && status == http.StatusOK {
			status = e.Status
		}
		if e.Message == "Invalid token" || e.Message == "Unauthorized." {
			status = http.StatusUnauthorized
		}
	}
	switch {
	case status == http.StatusUnauthorized, status == http.StatusForbidden && token != "":
		return ErrUnauthorized
	case status == http.StatusTooManyRequests:
		seconds, _ := strconv.Atoi(res.Header.Get("Retry-After"))
		return &RateLimited{RetryAfter: time.Duration(max(seconds, 60)) * time.Second}
	case status == http.StatusNotFound:
		return ErrNotFound
	case status >= 500:
		return fmt.Errorf("%w: HTTP %d", ErrUnavailable, status)
	case status != http.StatusOK || len(answer.Errors) > 0:
		msg := ""
		if len(answer.Errors) > 0 {
			msg = answer.Errors[0].Message
		}
		return fmt.Errorf("anilist: HTTP %d %s", status, msg)
	}
	if out == nil {
		return nil
	}
	if err := json.Unmarshal(answer.Data, out); err != nil {
		return fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	return nil
}
