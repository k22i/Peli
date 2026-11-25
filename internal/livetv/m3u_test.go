package livetv

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
)

// TestParsePlaylist is the playlist parser against what real playlists look
// like: a guide in the header, tvg attributes, headers for the stream, and the
// sloppiness the format allows.
func TestParsePlaylist(t *testing.T) {
	basic := []m3uFields{
		{
			Name:    "One",
			TvgID:   "one.example",
			TvgName: "Channel One",
			Logo:    "https://a.example/one.png",
			Group:   "News",
			URL:     "https://a.example/one.m3u8",
		},
		{
			Name:    "Two",
			TvgID:   "two.example",
			TvgName: "Channel Two",
			Logo:    "https://a.example/two.png",
			Group:   "Sport",
			URL:     "https://a.example/two.m3u8",
		},
		{
			Name:    "Three",
			TvgID:   "three.example",
			TvgName: "Channel Three",
			Logo:    "https://a.example/three.png",
			Group:   "Films",
			URL:     "https://a.example/three.m3u8",
		},
	}

	for _, tc := range []struct {
		name    string
		input   string
		guides  []string
		entries []m3uFields
	}{
		{
			name:    "a guide in the header and three full entries",
			input:   m3uFixture(t, "basic.m3u"),
			guides:  []string{"https://a.example/guide.xml.gz"},
			entries: basic,
		},
		{
			name:    "the same playlist with a BOM and CRLF line endings",
			input:   withCRLFBOM(m3uFixture(t, "basic.m3u")),
			guides:  []string{"https://a.example/guide.xml.gz"},
			entries: basic,
		},
		{
			name:  "entries with no attributes at all",
			input: m3uFixture(t, "no-attrs.m3u"),
			entries: []m3uFields{
				{Name: "Channel One", URL: "https://a.example/one.m3u8"},
				{Name: "Spaced", URL: "https://a.example/spaced.m3u8"},
			},
		},
		{
			name: "a user agent and a referrer from #EXTVLCOPT",
			input: "#EXTM3U\n" +
				"#EXTINF:-1,Live\n" +
				"#EXTVLCOPT:http-user-agent=VLC/3.0\n" +
				"#EXTVLCOPT:http-referrer=https://r.example/\n" +
				"https://a.example/live.m3u8\n",
			entries: []m3uFields{
				{
					Name:      "Live",
					URL:       "https://a.example/live.m3u8",
					UserAgent: "VLC/3.0",
					Headers:   map[string]string{"Referer": "https://r.example/"},
				},
			},
		},
		{
			name: "headers from #EXTHTTP, with the user agent kept apart",
			input: "#EXTM3U\n" +
				"#EXTINF:-1 tvg-id=\"x.example\",With headers\n" +
				"#EXTHTTP:{\"user-agent\":\"X/1\",\"cookie\":\"a=b\"}\n" +
				"https://a.example/headers.m3u8\n",
			entries: []m3uFields{
				{
					Name:      "With headers",
					TvgID:     "x.example",
					URL:       "https://a.example/headers.m3u8",
					UserAgent: "X/1",
					Headers:   map[string]string{"Cookie": "a=b"},
				},
			},
		},
		{
			name:  "a comma inside a quoted attribute",
			input: "#EXTM3U\n#EXTINF:-1 tvg-name=\"News, Weather\" group-title=\"A\",Real Name\nhttps://a.example/news.m3u8\n",
			entries: []m3uFields{
				{
					Name:    "Real Name",
					TvgName: "News, Weather",
					Group:   "A",
					URL:     "https://a.example/news.m3u8",
				},
			},
		},
		{
			name:  "#EXTGRP above an entry that names no group",
			input: "#EXTM3U\n#EXTGRP:Sports\n#EXTINF:-1,Sport One\nhttps://a.example/sport.m3u8\n",
			entries: []m3uFields{
				{Name: "Sport One", Group: "Sports", URL: "https://a.example/sport.m3u8"},
			},
		},
		{
			name:  "a bare list of URLs",
			input: "https://a.example/one.m3u8\nhttps://a.example/two.m3u8\n",
			entries: []m3uFields{
				{Name: "https://a.example/one.m3u8", URL: "https://a.example/one.m3u8"},
				{Name: "https://a.example/two.m3u8", URL: "https://a.example/two.m3u8"},
			},
		},
		{
			name:   "two header attributes, deduplicated",
			input:  "#EXTM3U url-tvg=\"a,b\" x-tvg-url=\"b, c\"\n#EXTINF:-1,One\nhttps://a.example/one.m3u8\n",
			guides: []string{"a", "b", "c"},
			entries: []m3uFields{
				{Name: "One", URL: "https://a.example/one.m3u8"},
			},
		},
		{
			name:  "a second #EXTINF replaces the entry waiting for its URL",
			input: "#EXTM3U\n#EXTINF:-1 tvg-id=\"dropped\",Dropped\n#EXTINF:-1 tvg-id=\"kept\",Kept\nhttps://a.example/kept.m3u8\n",
			entries: []m3uFields{
				{Name: "Kept", TvgID: "kept", URL: "https://a.example/kept.m3u8"},
			},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			p, err := ParsePlaylist(strings.NewReader(tc.input))
			if err != nil {
				t.Fatalf("ParsePlaylist: %v", err)
			}
			if !sameStrings(p.GuideURLs, tc.guides) {
				t.Errorf("GuideURLs = %v, want %v", p.GuideURLs, tc.guides)
			}
			if got := m3uProject(p); !reflect.DeepEqual(got, tc.entries) {
				t.Errorf("entries = %+v, want %+v", got, tc.entries)
			}
			for i, e := range p.Entries {
				if e.Headers == nil {
					t.Errorf("entry %d: Headers is nil; the rest of the package expects a map", i)
				}
				if _, ok := e.Headers["User-Agent"]; ok {
					t.Errorf("entry %d: a User-Agent header; it belongs in UserAgent", i)
				}
			}
		})
	}
}

// TestParsePlaylistErrors covers input that names no channel at all.
func TestParsePlaylistErrors(t *testing.T) {
	for _, input := range []string{"", "\n\n", "#EXTM3U\n", "#EXTM3U url-tvg=\"https://a.example/guide.xml.gz\"\n"} {
		p, err := ParsePlaylist(strings.NewReader(input))
		if !errors.Is(err, ErrNotPlaylist) {
			t.Errorf("ParsePlaylist(%q) = %v, want ErrNotPlaylist", input, err)
		}
		if len(p.Entries) != 0 {
			t.Errorf("ParsePlaylist(%q) gave %d entries", input, len(p.Entries))
		}
	}
}

// TestParsePlaylistReadError checks that a reader failing mid-file is reported
// with what was read so far.
func TestParsePlaylistReadError(t *testing.T) {
	p, err := ParsePlaylist(&failingPlaylistReader{})
	if err == nil || !strings.Contains(err.Error(), "livetv: reading the playlist") {
		t.Fatalf("ParsePlaylist = %v, want a read error", err)
	}
	if !errors.Is(err, errPlaylistBroke) {
		t.Errorf("ParsePlaylist error = %v, want it to wrap errPlaylistBroke", err)
	}
	if len(p.Entries) != 1 || p.Entries[0].Name != "One" {
		t.Errorf("ParsePlaylist gave %+v, want the entry read before the failure", p.Entries)
	}
}

// TestParsePlaylistLong checks a playlist with more entries than any list of
// tests could spell out, and that the last one is parsed as well as the first.
func TestParsePlaylistLong(t *testing.T) {
	const count = 2000
	var b strings.Builder
	b.WriteString("#EXTM3U url-tvg=\"https://a.example/guide.xml.gz\"\n")
	for i := 1; i <= count; i++ {
		fmt.Fprintf(&b, "#EXTINF:-1 tvg-id=\"c%d\" group-title=\"G%d\",Channel %d\nhttps://a.example/%d.m3u8\n", i, i%10, i, i)
	}

	p, err := ParsePlaylist(strings.NewReader(b.String()))
	if err != nil {
		t.Fatalf("ParsePlaylist: %v", err)
	}
	if len(p.Entries) != count {
		t.Fatalf("%d entries, want %d", len(p.Entries), count)
	}
	if !sameStrings(p.GuideURLs, []string{"https://a.example/guide.xml.gz"}) {
		t.Errorf("GuideURLs = %v", p.GuideURLs)
	}
	want := m3uFields{
		Name:    fmt.Sprintf("Channel %d", count),
		TvgID:   fmt.Sprintf("c%d", count),
		Group:   fmt.Sprintf("G%d", count%10),
		URL:     fmt.Sprintf("https://a.example/%d.m3u8", count),
		Headers: nil,
	}
	if got := m3uProject(p)[count-1]; !reflect.DeepEqual(got, want) {
		t.Errorf("the last entry = %+v, want %+v", got, want)
	}
}

// m3uFields is an Entry as the tables above spell it out. Headers is nil for an
// entry that needs none, so tables stay readable.
type m3uFields struct {
	Name      string
	TvgID     string
	TvgName   string
	Logo      string
	Group     string
	URL       string
	UserAgent string
	Headers   map[string]string
}

func m3uProject(p Playlist) []m3uFields {
	out := make([]m3uFields, 0, len(p.Entries))
	for _, e := range p.Entries {
		f := m3uFields{
			Name:      e.Name,
			TvgID:     e.TvgID,
			TvgName:   e.TvgName,
			Logo:      e.Logo,
			Group:     e.Group,
			URL:       e.URL,
			UserAgent: e.UserAgent,
		}
		if len(e.Headers) > 0 {
			f.Headers = make(map[string]string, len(e.Headers))
			for key, value := range e.Headers {
				f.Headers[key] = value
			}
		}
		out = append(out, f)
	}
	return out
}

// m3uFixture reads one of the playlists under testdata/m3u.
func m3uFixture(t *testing.T, name string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join("testdata", "m3u", name))
	if err != nil {
		t.Fatalf("reading %s: %v", name, err)
	}
	return string(data)
}

// withCRLFBOM writes a playlist the way a Windows editor saves it.
func withCRLFBOM(s string) string {
	return "\ufeff" + strings.ReplaceAll(s, "\n", "\r\n")
}

func sameStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for i := range got {
		if got[i] != want[i] {
			return false
		}
	}
	return true
}

// errPlaylistBroke is what failingPlaylistReader fails with.
var errPlaylistBroke = errors.New("the disk went away")

// failingPlaylistReader gives one entry and then fails, for the scanner's error path.
type failingPlaylistReader struct {
	read bool
}

func (r *failingPlaylistReader) Read(p []byte) (int, error) {
	if r.read {
		return 0, errPlaylistBroke
	}
	r.read = true
	return copy(p, "#EXTM3U\n#EXTINF:-1,One\nhttps://a.example/one.m3u8\n"), nil
}
