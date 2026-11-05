// Package anilistaddon is Sinag's AniList addon (#108, ADR-0045): a Stremio
// addon that runs inside the app at sinag://anilist/manifest.json and serves
// AniList's lists and details for anime. internal/addons answers the
// webview's requests for it with Handler.
//
// Stream addons only take Kitsu and IMDb ids for anime, so titles carry the
// Kitsu id internal/animelist maps them to, and an anilist: id only when
// there's none. Episode titles and thumbnails come from Kitsu's public API.
package anilistaddon

import (
	"context"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"golang.org/x/time/rate"

	"github.com/k22i/Sinag/internal/anilist"
	"github.com/k22i/Sinag/internal/animelist"
)

// Name is the addon's host: sinag://anilist/….
const Name = "anilist"

// KitsuURL is Kitsu's public API.
const KitsuURL = "https://kitsu.app/api/edge"

// How long answers are kept. Lists move slowly, and AniList allows about 90
// requests a minute (30 while degraded).
const (
	catalogTTL = 30 * time.Minute
	metaTTL    = 6 * time.Hour
	cacheCap   = 1000
)

// Addon answers the addon's requests.
type Addon struct {
	anilist *anilist.Client
	list    *animelist.List
	kitsu   string
	http    *http.Client
	version string
	now     func() time.Time

	limit *rate.Limiter

	mu      sync.Mutex
	cache   map[string]cached
	blocked time.Time // AniList said to wait until then
}

type cached struct {
	body    []byte
	expires time.Time
}

// New returns the addon, asking AniList through client, mapping ids with
// list and reading episodes from Kitsu's API at kitsu.
func New(client *anilist.Client, list *animelist.List, kitsu, version string) *Addon {
	return &Addon{
		anilist: client, list: list, kitsu: strings.TrimRight(kitsu, "/"),
		http: &http.Client{Timeout: 20 * time.Second}, version: version, now: time.Now,
		// About 85 a minute at most, in bursts of 10 (a Home page's rows).
		limit: rate.NewLimiter(rate.Every(700*time.Millisecond), 10),
		cache: map[string]cached{},
	}
}

var (
	errNotFound = errors.New("anilistaddon: not found")
	errBusy     = errors.New("anilistaddon: AniList asked to wait")
)

// ServeHTTP answers manifest, catalog and meta requests.
func (a *Addon) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.EscapedPath(), "/"), "/")
	for i, p := range parts {
		if u, err := url.PathUnescape(p); err == nil {
			parts[i] = u
		}
	}
	last := len(parts) - 1
	parts[last] = strings.TrimSuffix(parts[last], ".json")

	switch {
	case len(parts) == 1 && parts[0] == "manifest":
		writeJSON(w, http.StatusOK, a.manifest())
	case parts[0] == "catalog" && (len(parts) == 3 || len(parts) == 4):
		extra := url.Values{}
		if len(parts) == 4 {
			extra, _ = url.ParseQuery(parts[3])
		}
		a.serveCached(w, r.Context(), r.URL.EscapedPath(), catalogTTL, func(ctx context.Context) (any, error) {
			return a.catalog(ctx, parts[1], parts[2], extra)
		})
	case parts[0] == "meta" && len(parts) == 3:
		a.serveCached(w, r.Context(), r.URL.EscapedPath(), metaTTL, func(ctx context.Context) (any, error) {
			return a.meta(ctx, parts[1], parts[2])
		})
	default:
		http.NotFound(w, r)
	}
}

// serveCached answers from the cache, or from answer, keeping what it gives.
func (a *Addon) serveCached(w http.ResponseWriter, ctx context.Context, key string, ttl time.Duration, answer func(context.Context) (any, error)) {
	now := a.now()
	a.mu.Lock()
	hit, ok := a.cache[key]
	a.mu.Unlock()
	if ok && now.Before(hit.expires) {
		writeRaw(w, http.StatusOK, hit.body)
		return
	}
	v, err := answer(ctx)
	if err != nil {
		var limited *anilist.RateLimited
		switch {
		case errors.Is(err, errNotFound), errors.Is(err, anilist.ErrNotFound):
			writeJSON(w, http.StatusNotFound, map[string]string{"error": "not found"})
		case errors.As(err, &limited), errors.Is(err, errBusy):
			writeJSON(w, http.StatusServiceUnavailable, map[string]string{"error": "AniList asked Sinag to wait"})
		default:
			if ctx.Err() == nil {
				slog.Warn("anilistaddon: request failed", "error", err)
			}
			writeJSON(w, http.StatusBadGateway, map[string]string{"error": "AniList didn't answer"})
		}
		return
	}
	body, err := json.Marshal(v)
	if err != nil {
		writeJSON(w, http.StatusInternalServerError, map[string]string{"error": err.Error()})
		return
	}
	a.mu.Lock()
	if len(a.cache) >= cacheCap {
		for k, c := range a.cache {
			if !now.Before(c.expires) {
				delete(a.cache, k)
			}
		}
		if len(a.cache) >= cacheCap {
			a.cache = map[string]cached{}
		}
	}
	a.cache[key] = cached{body: body, expires: now.Add(ttl)}
	a.mu.Unlock()
	writeRaw(w, http.StatusOK, body)
}

// query asks AniList, within the rate limit, and waits out a 429 by
// answering busy until AniList's Retry-After has passed.
func (a *Addon) query(ctx context.Context, query string, variables map[string]any, out any) error {
	a.mu.Lock()
	blocked := a.now().Before(a.blocked)
	a.mu.Unlock()
	if blocked {
		return errBusy
	}
	if err := a.limit.Wait(ctx); err != nil {
		return err
	}
	err := a.anilist.Public(ctx, query, variables, out)
	var limited *anilist.RateLimited
	if errors.As(err, &limited) {
		a.mu.Lock()
		a.blocked = a.now().Add(limited.RetryAfter)
		a.mu.Unlock()
	}
	return err
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	body, _ := json.Marshal(v)
	writeRaw(w, status, body)
}

func writeRaw(w http.ResponseWriter, status int, body []byte) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_, _ = w.Write(body)
}
