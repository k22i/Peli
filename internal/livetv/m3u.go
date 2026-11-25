package livetv

import (
	"errors"
	"io"
)

// ErrNotPlaylist is what ParsePlaylist returns for input with no entries.
var ErrNotPlaylist = errors.New("livetv: not a playlist")

// Playlist is a parsed M3U/M3U8 file.
type Playlist struct {
	// GuideURLs are the header's url-tvg / x-tvg-url values, in order, split
	// on commas, trimmed, empty ones dropped.
	GuideURLs []string
	Entries   []Entry
}

// Entry is one channel of a playlist, with its stream.
type Entry struct {
	Name    string // after the #EXTINF comma; tvg-name, then the URL, when empty
	TvgID   string
	TvgName string
	Logo    string // tvg-logo
	Group   string // group-title, else the last #EXTGRP
	URL     string
	// Headers are the request headers the stream needs, canonical names
	// ("Referer", "Origin", "Cookie"); never "User-Agent", which is UserAgent.
	Headers   map[string]string
	UserAgent string
}

// ParsePlaylist reads an M3U/M3U8 playlist (W1: TODO).
func ParsePlaylist(r io.Reader) (Playlist, error) {
	_ = r
	return Playlist{}, ErrNotPlaylist
}
