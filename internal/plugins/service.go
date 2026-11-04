package plugins

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

const (
	// maxCode caps a plugin's code. The largest community bundles are
	// about 2 MB (#56).
	maxCode = 8 << 20
	// codeFor is how long downloaded code is kept before it's asked for
	// again.
	codeFor = 10 * time.Minute
	// DevManifestEnv names a plugin manifest URL whose enabled plugins
	// Installed lists, until plugin management (#57) keeps a list.
	DevManifestEnv = "SINAG_DEV_PLUGINS"
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

	mu    sync.Mutex
	codes map[string]code
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
	}
}

// Streams asks plugin for query's streams, in a sandbox with the default
// limits. Cancelling ctx (the frontend leaving the picker) kills it.
func (s *Service) Streams(ctx context.Context, plugin Plugin, query Query) ([]Stream, error) {
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

// Installed is the plugins to ask. Until plugin management (#57) there's
// no list to keep, and plugins are off by default, so it's empty unless
// $SINAG_DEV_PLUGINS names a manifest: then it's that manifest's enabled
// plugins, for trying plugins out in a dev build.
func (s *Service) Installed(ctx context.Context) ([]Plugin, error) {
	link := os.Getenv(DevManifestEnv)
	if link == "" {
		return []Plugin{}, nil
	}
	data, err := s.get(ctx, link, 4<<20)
	if err != nil {
		return nil, err
	}
	m, err := ParseManifest(data, link)
	if err != nil {
		return nil, fmt.Errorf("%w: %v", ErrUnreachable, err)
	}
	out := []Plugin{}
	for _, sc := range m.Scrapers {
		if !sc.Enabled {
			continue
		}
		out = append(out, Plugin{ID: sc.ID, Name: sc.Name, Version: sc.Version, URL: sc.File, SupportedTypes: sc.SupportedTypes})
	}
	return out, nil
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
