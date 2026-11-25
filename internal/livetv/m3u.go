package livetv

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"slices"
	"strings"
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

// ParsePlaylist reads an M3U/M3U8 playlist: the header's guide URLs, then each
// #EXTINF entry's attributes, name, request headers and stream URL. It
// tolerates a BOM, CRLF line endings and playlists without an #EXTM3U header,
// and returns ErrNotPlaylist when nothing in it names a channel.
func ParsePlaylist(r io.Reader) (Playlist, error) {
	var p Playlist

	scanner := bufio.NewScanner(r)
	// #EXTINF lines with many attributes, and #EXTHTTP with several headers,
	// run long; a megabyte a line is far more than a playlist needs.
	scanner.Buffer(make([]byte, 64*1024), 1<<20)

	// carriedGroup is a group named before any entry (#EXTGRP above an
	// #EXTINF): it belongs to the next entry that doesn't name one itself.
	var carriedGroup string
	// pending is the entry whose #EXTINF we've read and whose URL line we're
	// waiting for.
	var pending *pendingEntry
	first := true

	for scanner.Scan() {
		line := strings.TrimSuffix(scanner.Text(), "\r")
		if first {
			// A BOM in front of #EXTM3U would hide the header.
			line = strings.TrimPrefix(line, "\ufeff")
			first = false
		}
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}

		switch {
		case strings.HasPrefix(line, "#EXTM3U"):
			// The header may name the guide the channels are matched against.
			attrs := parseAttributes(strings.TrimPrefix(line, "#EXTM3U"))
			for _, key := range []string{"url-tvg", "x-tvg-url"} {
				for _, part := range strings.Split(attrs[key], ",") {
					part = strings.TrimSpace(part)
					if part == "" || slices.Contains(p.GuideURLs, part) {
						continue
					}
					p.GuideURLs = append(p.GuideURLs, part)
				}
			}

		case strings.HasPrefix(line, "#EXTINF:"):
			pending = parseExtinf(strings.TrimPrefix(line, "#EXTINF:"))
			if pending.entry.Group == "" && carriedGroup != "" {
				pending.entry.Group = carriedGroup
				carriedGroup = ""
			}

		case strings.HasPrefix(line, "#EXTVLCOPT:"):
			if pending != nil {
				applyVLCOption(&pending.entry, strings.TrimPrefix(line, "#EXTVLCOPT:"))
			}

		case strings.HasPrefix(line, "#EXTHTTP:"):
			if pending != nil {
				applyHTTPHeaders(&pending.entry, strings.TrimPrefix(line, "#EXTHTTP:"))
			}

		case strings.HasPrefix(line, "#EXTGRP:"):
			group := strings.TrimSpace(strings.TrimPrefix(line, "#EXTGRP:"))
			switch {
			case pending == nil:
				carriedGroup = group
			case !pending.attrGroup:
				// group-title wins over #EXTGRP when an entry has both.
				pending.entry.Group = group
			}

		case strings.HasPrefix(line, "#"):
			// Any other directive (#PLAYLIST, #EXT-X-VERSION, a comment) says
			// nothing about a channel.

		default:
			// A URL line completes the pending entry, or stands alone in a
			// playlist that is nothing but a list of streams.
			if pending == nil {
				p.Entries = append(p.Entries, finishEntry(Entry{Name: line, URL: line}))
				continue
			}
			pending.entry.URL = line
			p.Entries = append(p.Entries, finishEntry(pending.entry))
			pending = nil
		}
	}
	if err := scanner.Err(); err != nil {
		return p, fmt.Errorf("livetv: reading the playlist: %w", err)
	}
	if len(p.Entries) == 0 {
		return p, ErrNotPlaylist
	}
	return p, nil
}

// pendingEntry is an #EXTINF waiting for the URL line after it.
type pendingEntry struct {
	entry Entry
	// attrGroup is true when the #EXTINF carried a group-title, which wins
	// over any #EXTGRP.
	attrGroup bool
}

// parseExtinf reads the text after "#EXTINF:".
func parseExtinf(rest string) *pendingEntry {
	head, name := splitExtinf(rest)

	// The duration is the first token and is of no use to us; everything
	// after it is attributes.
	head = strings.TrimSpace(head)
	if i := strings.IndexAny(head, " \t"); i >= 0 {
		head = head[i:]
	} else {
		head = ""
	}
	attrs := parseAttributes(head)

	entry := Entry{
		Name:      strings.TrimSpace(name),
		TvgID:     attrs["tvg-id"],
		TvgName:   attrs["tvg-name"],
		Logo:      attrs["tvg-logo"],
		Headers:   map[string]string{},
		UserAgent: firstOf(attrs, "http-user-agent", "user-agent"),
	}
	if referrer := firstOf(attrs, "http-referrer", "http-referer"); referrer != "" {
		entry.Headers["Referer"] = referrer
	}

	p := &pendingEntry{entry: entry}
	if group := strings.TrimSpace(attrs["group-title"]); group != "" {
		p.entry.Group = group
		p.attrGroup = true
	}
	return p
}

// splitExtinf splits an #EXTINF at the first comma outside quotes: the
// duration and attributes come before it, the channel's name after it. A line
// with no such comma names no channel, so all of it is attributes.
func splitExtinf(s string) (head, name string) {
	quoted := false
	for i := 0; i < len(s); i++ {
		switch s[i] {
		case '"':
			quoted = !quoted
		case ',':
			if !quoted {
				return s[:i], s[i+1:]
			}
		}
	}
	return s, ""
}

// applyVLCOption reads one #EXTVLCOPT:key=value into the entry's request.
func applyVLCOption(e *Entry, rest string) {
	key, value, ok := strings.Cut(rest, "=")
	if !ok {
		return
	}
	key = strings.ToLower(strings.TrimSpace(key))
	value = strings.TrimSpace(value)
	switch key {
	case "http-user-agent":
		e.UserAgent = value
	case "http-referrer", "http-referer":
		e.Headers["Referer"] = value
	case "http-origin":
		e.Headers["Origin"] = value
	case "http-cookie":
		e.Headers["Cookie"] = value
	}
}

// applyHTTPHeaders reads an #EXTHTTP:{json} object into the entry's request.
// Broken JSON is ignored: the stream plays without the headers.
func applyHTTPHeaders(e *Entry, rest string) {
	var headers map[string]string
	if err := json.Unmarshal([]byte(strings.TrimSpace(rest)), &headers); err != nil {
		return
	}
	for key, value := range headers {
		name := http.CanonicalHeaderKey(key)
		switch name {
		case "":
			// A key that isn't a header name at all.
			continue
		case "User-Agent":
			// Kept apart, so a playlist can't set it twice.
			e.UserAgent = value
			continue
		}
		e.Headers[name] = value
	}
}

// finishEntry fills in what a playlist is allowed to leave out, so the rest of
// the package never sees a half-built entry.
func finishEntry(e Entry) Entry {
	if e.Name == "" {
		e.Name = e.TvgName
	}
	if e.Name == "" {
		e.Name = e.URL
	}
	if e.Headers == nil {
		e.Headers = map[string]string{}
	}
	delete(e.Headers, "User-Agent")
	return e
}

// firstOf gives the first of the named attributes that the playlist set.
func firstOf(attrs map[string]string, keys ...string) string {
	for _, key := range keys {
		if value := attrs[key]; value != "" {
			return value
		}
	}
	return ""
}

// parseAttributes reads key="value", key='value' and key=value pairs. Keys are
// lowercased. Anything that doesn't fit is skipped rather than refused, since
// real playlists carry half the attributes the M3U format allows.
func parseAttributes(s string) map[string]string {
	attrs := make(map[string]string)
	for i := 0; i < len(s); {
		if !isAttributeKeyByte(s[i]) {
			i++
			continue
		}
		start := i
		for i < len(s) && isAttributeKeyByte(s[i]) {
			i++
		}
		key := strings.ToLower(s[start:i])
		if i >= len(s) || s[i] != '=' {
			continue
		}
		i++ // past the '='

		var value string
		if i < len(s) && (s[i] == '"' || s[i] == '\'') {
			quote := s[i]
			i++
			if end := strings.IndexByte(s[i:], quote); end >= 0 {
				value = s[i : i+end]
				i += end + 1
			} else {
				// Unbalanced, so the value runs to the end of the line.
				value = s[i:]
				i = len(s)
			}
		} else if end := strings.IndexByte(s[i:], ' '); end >= 0 {
			// Unquoted values stop at the next space.
			value = s[i : i+end]
			i += end + 1
		} else {
			value = s[i:]
			i = len(s)
		}
		attrs[key] = value
	}
	return attrs
}

func isAttributeKeyByte(c byte) bool {
	return c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' || c >= '0' && c <= '9' || c == '_' || c == '-'
}
