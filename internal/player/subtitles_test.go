//go:build !ios

package player

import (
	"bytes"
	"compress/gzip"
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"

	"github.com/k22i/Peli/internal/streams"
)

const srt = "1\n00:00:00,000 --> 00:00:03,000\nBonjour\n"

// subtitleServer serves srt at /fr.srt and gzipped at /fr.srt.gz, 404 at
// /gone.srt and a body mpv can't read at /junk.srt. It records each
// request's User-Agent and Authorization.
func subtitleServer(t *testing.T) (*httptest.Server, func() []http.Header) {
	t.Helper()
	var mu sync.Mutex
	var seen []http.Header
	var gz bytes.Buffer
	w := gzip.NewWriter(&gz)
	_, _ = w.Write([]byte(srt))
	_ = w.Close()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		mu.Lock()
		seen = append(seen, r.Header.Clone())
		mu.Unlock()
		switch r.URL.Path {
		case "/fr.srt":
			_, _ = w.Write([]byte(srt))
		case "/fr.srt.gz":
			_, _ = w.Write(gz.Bytes())
		case "/junk.srt":
			_, _ = w.Write(bytes.Repeat([]byte{0, 1, 2, 3}, 64))
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, func() []http.Header {
		mu.Lock()
		defer mu.Unlock()
		return append([]http.Header{}, seen...)
	}
}

func TestAddSubtitle(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	srv, seen := subtitleServer(t)
	ctx := context.Background()
	if _, err := s.AddSubtitle(ctx, Subtitle{URL: srv.URL + "/fr.srt", Lang: "fr"}); !errors.Is(err, ErrNotPlaying) {
		t.Fatalf("before Load: got %v, want ErrNotPlaying", err)
	}
	path, _ := filepath.Abs("testdata/tracks.mkv")
	source := streams.Source{URL: path, Headers: map[string]string{"Authorization": "Bearer debrid"}}
	if err := s.Load(source, LoadOptions{Captions: "off"}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { st := s.Snapshot(); return !st.Loading && len(st.Tracks) > 0 })
	if err := s.SetPaused(true); err != nil {
		t.Fatal(err)
	}

	for _, name := range []string{"/fr.srt", "/fr.srt.gz"} {
		id, err := s.AddSubtitle(ctx, Subtitle{URL: srv.URL + name, Lang: "fr", Title: "Test addon"})
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		r.waitFor(t, name+" selected", func(*recorder) bool {
			for _, tr := range s.Snapshot().Tracks {
				if tr.ID == id {
					return tr.Selected
				}
			}
			return false
		})
		var added Track
		for _, tr := range s.Snapshot().Tracks {
			if tr.ID == id {
				added = tr
			}
		}
		if added.Type != "sub" || !added.External || added.Lang != "fr" || added.Title != "Test addon" {
			t.Errorf("%s: track %+v, want an external French sub titled Test addon", name, added)
		}
	}
	for _, h := range seen() {
		if !strings.HasPrefix(h.Get("User-Agent"), "Peli/") || h.Get("Authorization") != "" {
			t.Errorf("request headers %v, want Peli's User-Agent and not the stream's", h)
		}
	}

	for name, sub := range map[string]Subtitle{
		"ftp":             {URL: "ftp://example.com/a.srt"},
		"a language list": {URL: srv.URL + "/fr.srt", Lang: "fr,en"},
	} {
		if _, err := s.AddSubtitle(ctx, sub); !errors.Is(err, ErrInvalid) {
			t.Errorf("%s: got %v, want ErrInvalid", name, err)
		}
	}
	for _, name := range []string{"/gone.srt", "/junk.srt"} {
		_, err := s.AddSubtitle(ctx, Subtitle{URL: srv.URL + name})
		if !errors.Is(err, ErrSubtitles) {
			t.Errorf("%s: got %v, want ErrSubtitles", name, err)
		}
		if err != nil && strings.Contains(err.Error(), srv.URL) {
			t.Errorf("%s: error %q names the URL", name, err)
		}
	}

	// The files go with the session.
	s.ops.Lock()
	dir := s.s.subDir
	s.ops.Unlock()
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("subtitle dir %q after Stop: %v, want it gone", dir, err)
	}
}
