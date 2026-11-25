// Package livetv is Live TV (ADR-0066): IPTV channels from M3U playlists,
// with a programme guide from XMLTV. A source is a playlist URL plus an
// optional guide URL, both kept in the keychain (they can carry an Xtream
// username and password); the store keeps only the source's id, profile,
// name and timestamps. Go fetches and parses both, caches the result on disk
// and hands the frontend channels, guide data and, at play time, a channel's
// stream.
//
// Files: livetv.go (types, codes, events), m3u.go and channels.go (the
// playlist), xmltv.go and match.go (the guide), service.go and the files
// beside it (fetching, the cache, refreshing, the bound methods).
package livetv

import (
	"encoding/json"
	"errors"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/secrets"
	"github.com/k22i/Peli/internal/store"
)

// EventUpdated is sent when a source's refresh starts or ends, and when a
// source is added, renamed or removed.
const EventUpdated = "livetv:updated"

func init() {
	application.RegisterEvent[Updated](EventUpdated)
}

// Updated names the source that changed.
type Updated struct {
	ProfileID uint64 `json:"profileId"`
	SourceID  string `json:"sourceId"`
}

// Error codes (MarshalError, and a Source's PlaylistError and GuideError).
const (
	CodeInvalid     = "invalid"      // a bad URL, name or id
	CodeNotFound    = "not_found"    // no such source, channel or profile
	CodeKids        = "kids_profile" // kids profiles have no Live TV
	CodeUnreachable = "unreachable"  // DNS, connection refused, a 4xx/5xx, a missing file
	CodeTimeout     = "timeout"
	CodeTooLarge    = "too_large"    // over the download cap
	CodeNotPlaylist = "not_playlist" // no channels in it
	CodeNotGuide    = "not_guide"    // not XMLTV, or no programme in it
	CodeKeychain    = "keychain"     // the URLs couldn't be kept or read
	CodeFailed      = "failed"
)

// Error is a refusal or a failure with a code. Its text never holds a URL.
type Error struct{ Code string }

func (e *Error) Error() string { return "livetv: " + e.Code }

func fail(code string) error { return &Error{Code: code} }

// codeOf names an error for the frontend.
func codeOf(err error) string {
	var e *Error
	switch {
	case errors.As(err, &e):
		return e.Code
	case errors.Is(err, store.ErrLiveSourceNotFound), errors.Is(err, store.ErrProfileNotFound):
		return CodeNotFound
	case errors.Is(err, store.ErrInvalidItem):
		return CodeInvalid
	case errors.Is(err, secrets.ErrNotFound):
		return CodeKeychain
	}
	return CodeFailed
}

// MarshalError gives the frontend a code for each error.
func MarshalError(err error) []byte {
	code := codeOf(err)
	data, _ := json.Marshal(map[string]string{"code": code, "message": "livetv: " + code})
	return data
}

// Keychain is where the sources' URLs are kept: *secrets.Keychain in the
// app, a map in tests. Get returns secrets.ErrNotFound for a missing key.
type Keychain interface {
	Get(key string) (string, error)
	Set(key, value string) error
	Delete(key string) error
}

// Config is what the service is built from.
type Config struct {
	Open     func() *store.Store
	Keychain Keychain
	// CacheDir holds the parsed playlists and guides, a folder per source:
	// filepath.Join(os.UserCacheDir(), "Peli", "livetv") in the app.
	CacheDir string
	// Version is sent in the User-Agent.
	Version string
}

// SourceInput is what AddSource takes. Name may be "": the playlist's host
// or file name stands in. GuideURL may be "": the playlist's url-tvg or
// x-tvg-url header stands in. Each URL is http(s)://, file:// or a local
// path ("/…", "~/…", "C:\…").
type SourceInput struct {
	ProfileID   uint64 `json:"profileId"`
	Name        string `json:"name"`
	PlaylistURL string `json:"playlistUrl"`
	GuideURL    string `json:"guideUrl"`
}

// Source is a source as the frontend sees it: the store's record and what
// the last refresh found. It never holds a URL.
type Source struct {
	ID        string `json:"id"`
	ProfileID uint64 `json:"profileId"`
	Name      string `json:"name"`
	CreatedAt int64  `json:"createdAt"` // unix ms
	UpdatedAt int64  `json:"updatedAt"` // unix ms
	// HasGuide: a guide URL was given, or the playlist names one
	// (GuideFromPlaylist).
	HasGuide          bool `json:"hasGuide"`
	GuideFromPlaylist bool `json:"guideFromPlaylist"`
	// What the last good fetches gave: the playlist's channels, the
	// channels the guide matched, and the programmes kept for them.
	Channels      int `json:"channels"`
	GuideChannels int `json:"guideChannels"`
	Programmes    int `json:"programmes"`
	// When each was last fetched and parsed, unix ms; 0 for never.
	PlaylistAt int64 `json:"playlistAt"`
	GuideAt    int64 `json:"guideAt"`
	// The last try's error code (Code…), "" when it worked or wasn't made.
	PlaylistError string `json:"playlistError"`
	GuideError    string `json:"guideError"`
	// Refreshing is true while a fetch for it runs.
	Refreshing bool `json:"refreshing"`
}

// Channel is one playlist entry, without its stream: Stream hands that over
// at play time.
type Channel struct {
	// ID is "<source id>:<12 hex>", stable across refreshes (channels.go).
	ID       string `json:"id"`
	SourceID string `json:"sourceId"`
	// Number is the entry's place in its playlist, from 1.
	Number int    `json:"number"`
	Name   string `json:"name"`
	// Logo is a URL, or "".
	Logo string `json:"logo"`
	// Group is the group-title (or #EXTGRP), "" for none.
	Group   string `json:"group"`
	TvgID   string `json:"tvgId"`
	TvgName string `json:"tvgName"`
}

// Programme is one guide entry. Times are unix ms.
type Programme struct {
	// ChannelID is our Channel.ID, not the guide's own channel id.
	ChannelID   string   `json:"channelId"`
	Start       int64    `json:"start"`
	Stop        int64    `json:"stop"`
	Title       string   `json:"title"`
	SubTitle    string   `json:"subTitle"`
	Description string   `json:"description"`
	Categories  []string `json:"categories"`
	// Episode is "S1 E3" (from xmltv_ns), else the onscreen text, else "".
	Episode string `json:"episode"`
	// Icon is a URL, or "".
	Icon string `json:"icon"`
}

// ChannelGuide is one channel's programmes, in order.
type ChannelGuide struct {
	ChannelID  string      `json:"channelId"`
	Programmes []Programme `json:"programmes"`
}

// NowNext is what a channel shows now and next; nil for unknown.
type NowNext struct {
	ChannelID string     `json:"channelId"`
	Now       *Programme `json:"now"`
	Next      *Programme `json:"next"`
}
