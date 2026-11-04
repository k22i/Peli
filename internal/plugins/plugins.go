// Package plugins runs Nuvio's JS plugins (its "local scrapers", F18) in a
// sandbox (#56): each call is a fresh goja runtime in a child process of
// Sinag's own binary, with no file or process access, network only through
// the host's fetch, and a hard time and memory limit. The host API (fetch,
// HTML parsing, crypto-js, URL, timers and so on) is written from how the
// community plugins behave, not from Nuvio's GPL code. See ADR-0043.
//
// A plugin is one CommonJS file exporting getStreams(tmdbId, mediaType,
// season, episode), which answers a promise of streams. Plugins scrape web
// sites, so their answers are checked like any untrusted input. Stream URLs
// and plugin logs are never logged by Sinag.
package plugins

import (
	"errors"
	"time"
)

var (
	// ErrInvalidPlugin means the code didn't compile or didn't export
	// getStreams.
	ErrInvalidPlugin = errors.New("plugins: not a plugin")
	// ErrTimeout means the plugin didn't answer within its time limit.
	ErrTimeout = errors.New("plugins: plugin didn't answer in time")
	// ErrMemory means the plugin went over its memory limit.
	ErrMemory = errors.New("plugins: plugin used too much memory")
	// ErrFailed means the plugin threw, or its promise was rejected.
	ErrFailed = errors.New("plugins: plugin failed")
	// ErrBadAnswer means the plugin answered something other than a list
	// of streams.
	ErrBadAnswer = errors.New("plugins: plugin answered badly")
	// ErrStalled means the plugin's promise never settled and nothing it
	// started (a request, a timer) was left to settle it.
	ErrStalled = errors.New("plugins: plugin stopped without answering")
	// ErrCrashed means the sandbox process died without answering.
	ErrCrashed = errors.New("plugins: sandbox crashed")
	// ErrUnreachable means the plugin's code couldn't be downloaded.
	ErrUnreachable = errors.New("plugins: plugin code unreachable")
)

// Error codes the frontend reads (MarshalError).
const (
	CodeInvalidPlugin = "invalid_plugin"
	CodeTimeout       = "timeout"
	CodeMemory        = "memory"
	CodeFailed        = "failed"
	CodeBadAnswer     = "bad_answer"
	CodeStalled       = "stalled"
	CodeCrashed       = "crashed"
	CodeUnreachable   = "unreachable"
)

var codes = map[error]string{
	ErrInvalidPlugin: CodeInvalidPlugin,
	ErrTimeout:       CodeTimeout,
	ErrMemory:        CodeMemory,
	ErrFailed:        CodeFailed,
	ErrBadAnswer:     CodeBadAnswer,
	ErrStalled:       CodeStalled,
	ErrCrashed:       CodeCrashed,
	ErrUnreachable:   CodeUnreachable,
}

// codeOf is err's code, or CodeFailed.
func codeOf(err error) string {
	for e, code := range codes {
		if errors.Is(err, e) {
			return code
		}
	}
	return CodeFailed
}

// errorOf is the error for a code, the other way round.
func errorOf(code string) error {
	for e, c := range codes {
		if c == code {
			return e
		}
	}
	return ErrFailed
}

// Query is what a plugin is asked for, as Nuvio asks: a TMDB id, "movie" or
// "tv", and for an episode its season and number (from 1).
type Query struct {
	TmdbID    string `json:"tmdbId"`
	MediaType string `json:"mediaType"`
	Season    int    `json:"season,omitempty"`
	Episode   int    `json:"episode,omitempty"`
}

// Stream is one stream a plugin found, cleaned up: an http or https URL,
// with the headers to ask for it with. Name is usually the site, Title the
// file or a description, Quality "1080p" and so on, Size "2.5 GB".
type Stream struct {
	Name    string            `json:"name"`
	Title   string            `json:"title"`
	URL     string            `json:"url"`
	Quality string            `json:"quality,omitempty"`
	Size    string            `json:"size,omitempty"`
	Headers map[string]string `json:"headers,omitempty"`
}

// Limits bound one call of a plugin.
type Limits struct {
	// Timeout is the whole call, from starting the sandbox to the answer.
	Timeout time.Duration `json:"timeout"`
	// Memory is the most heap the sandbox may hold, in bytes.
	Memory int64 `json:"memory"`
	// Requests is the most fetches one call may make.
	Requests int `json:"requests"`
	// Body is the largest response body a fetch reads, in bytes.
	Body int64 `json:"body"`
	// Streams is the most streams kept from an answer.
	Streams int `json:"streams"`
	// PrivateNetwork lets fetch reach loopback and private addresses. Only
	// tests set it: a plugin must not reach the user's router, LAN or
	// Sinag's own loopback servers (the torrent link, #55).
	PrivateNetwork bool `json:"privateNetwork,omitempty"`
}

// DefaultLimits are a call's limits unless the caller sets others. The
// addons' 30 s (#50) is too short for plugins: they scrape a search page,
// a title page and an embed host in turn.
var DefaultLimits = Limits{
	Timeout:  45 * time.Second,
	Memory:   256 << 20,
	Requests: 200,
	Body:     16 << 20,
	Streams:  500,
}

// Job is one call of a plugin, as the sandbox process receives it.
type Job struct {
	// ID is the plugin's id, given to it as SCRAPER_ID.
	ID string `json:"id"`
	// Code is the plugin's source.
	Code     string         `json:"code"`
	Query    Query          `json:"query"`
	Settings map[string]any `json:"settings,omitempty"`
	Limits   Limits         `json:"limits"`
	// UserAgent is fetch's when the plugin doesn't set one.
	UserAgent string `json:"userAgent"`
}
