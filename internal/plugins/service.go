package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/k22i/Sinag/internal/store"
)

const (
	// maxCode caps a plugin's code. The largest community bundles are
	// about 2 MB (#56).
	maxCode = 8 << 20
	// codeFor is how long downloaded code is kept before it's asked for
	// again.
	codeFor = 10 * time.Minute
)

// Plugin is a plugin to call: its id and name, and where its code is.
// Settings become its SCRAPER_SETTINGS.
type Plugin struct {
	ID             string         `json:"id"`
	Name           string         `json:"name"`
	Version        string         `json:"version"`
	URL            string         `json:"url"`
	SupportedTypes []string       `json:"supportedTypes"`
	Settings       map[string]any `json:"settings,omitempty"`
}

// Service is the Wails service the frontend calls for plugin streams.
type Service struct {
	runner    *Runner
	http      *http.Client
	userAgent string

	// The store plugins are kept in and the guarded way to change it
	// (UseStore).
	open func() *store.Store
	edit Editor

	mu    sync.Mutex
	codes map[string]code
	// When a repository's manifest last failed to load, by URL (Refresh).
	failedAt map[string]time.Time
}

type code struct {
	source string
	at     time.Time
}

// NewService returns a Service that runs plugins in sandboxes started from
// this executable.
func NewService(version string) *Service {
	return &Service{
		runner:    NewRunner(),
		http:      &http.Client{Timeout: 30 * time.Second},
		userAgent: fmt.Sprintf("Sinag/%s (+https://github.com/k22i/Sinag)", version),
		codes:     map[string]code{},
		failedAt:  map[string]time.Time{},
	}
}

// Streams asks plugin for query's streams, in a sandbox with the default
// limits. Cancelling ctx (the frontend leaving the picker) kills it.
//
// Only a plugin Installed lists is asked, and with the settings kept for it,
// not the ones the caller sent: with plugins off, or on a kids profile, or
// for a plugin that was turned off, nothing runs (#57, ADR-0047).
func (s *Service) Streams(ctx context.Context, plugin Plugin, query Query) ([]Stream, error) {
	installed, err := s.Installed(ctx)
	if err != nil {
		return nil, err
	}
	i := slices.IndexFunc(installed, func(p Plugin) bool { return p.ID == plugin.ID && p.URL == plugin.URL })
	if i < 0 {
		return nil, ErrNotEnabled
	}
	return s.run(ctx, installed[i], query)
}

// run is Streams for a plugin that has been checked.
func (s *Service) run(ctx context.Context, plugin Plugin, query Query) ([]Stream, error) {
	if query.TmdbID == "" || (query.MediaType != "movie" && query.MediaType != "tv") {
		return nil, fmt.Errorf("%w: a TMDB id and movie or tv", ErrBadAnswer)
	}
	if query.MediaType == "movie" {
		query.Season, query.Episode = 0, 0
	}
	source, err := s.code(ctx, plugin)
	if err != nil {
		return nil, err
	}
	return s.runner.Run(ctx, Job{
		ID:        plugin.ID,
		Code:      source,
		Query:     query,
		Settings:  plugin.Settings,
		Limits:    DefaultLimits,
		UserAgent: s.userAgent,
	})
}

// code is the plugin's source, downloaded or from the last ten minutes.
func (s *Service) code(ctx context.Context, plugin Plugin) (string, error) {
	key := plugin.URL + "#" + plugin.Version
	s.mu.Lock()
	cached, ok := s.codes[key]
	s.mu.Unlock()
	if ok && time.Since(cached.at) < codeFor {
		return cached.source, nil
	}
	data, err := s.get(ctx, plugin.URL, maxCode)
	if err != nil {
		return "", err
	}
	source := string(data)
	s.mu.Lock()
	s.codes[key] = code{source: source, at: time.Now()}
	s.mu.Unlock()
	return source, nil
}

func (s *Service) get(ctx context.Context, link string, max int64) ([]byte, error) {
	if !strings.HasPrefix(link, "https://") && !strings.HasPrefix(link, "http://") {
		return nil, fmt.Errorf("%w: not an http or https URL", ErrUnreachable)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, link, nil)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	req.Header.Set("User-Agent", s.userAgent)
	resp, err := s.http.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, ErrUnreachable
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("%w: HTTP %d", ErrUnreachable, resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, max+1))
	if err != nil {
		return nil, ErrUnreachable
	}
	if int64(len(data)) > max {
		return nil, fmt.Errorf("%w: too large", ErrUnreachable)
	}
	return data, nil
}

// MarshalError gives the frontend an error's code, as {"code": …}. The
// message stays out: a plugin's error can quote the pages it scraped.
func MarshalError(err error) []byte {
	code := CodeFailed
	if errors.Is(err, context.Canceled) {
		code = "cancelled"
	} else {
		code = codeOf(err)
	}
	data, _ := json.Marshal(map[string]string{"code": code})
	return data
}
