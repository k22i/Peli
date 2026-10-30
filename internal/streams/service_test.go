package streams

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

// The key Torrentio puts in its resolve path, and the token on the CDN link.
const (
	key      = "0123456789abcdef-debrid-key"
	cdnToken = "cdn-token-fedcba9876543210"
)

// debrid stands in for Torrentio with TorBox (as recorded for #53): a
// resolve URL redirecting to the service's requestdl, then to the CDN, or
// to one of Torrentio's notice videos. Each request's headers are kept.
type debrid struct {
	*httptest.Server
	seen []http.Header
}

func newDebrid(t *testing.T) *debrid {
	d := &debrid{}
	file := func(w http.ResponseWriter, kind string, total int) {
		w.Header().Set("Content-Type", kind)
		w.Header().Set("Accept-Ranges", "bytes")
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-0/%d", total))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write([]byte{0})
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/resolve/torbox/"+key+"/cached/", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/requestdl?token="+key+"&torrent_id=1&file_id=2&redirect=true", http.StatusFound)
	})
	mux.HandleFunc("/requestdl", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/dld/9b2c?token="+cdnToken, http.StatusTemporaryRedirect)
	})
	mux.HandleFunc("/dld/9b2c", func(w http.ResponseWriter, r *http.Request) {
		file(w, "application/octet-stream", 7_414_250_351)
	})
	for _, reason := range []string{"downloading_v3", "failed_access_v2", "limits_exceeded_v1", "failed_rar_v2"} {
		mux.HandleFunc("/resolve/torbox/"+key+"/"+reason+"/", func(w http.ResponseWriter, r *http.Request) {
			http.Redirect(w, r, "/videos/"+reason+".mp4", http.StatusFound)
		})
		mux.HandleFunc("/videos/"+reason+".mp4", func(w http.ResponseWriter, _ *http.Request) {
			file(w, "video/mp4", 118_743)
		})
	}
	mux.HandleFunc("/static/exceptions/torrent_not_downloaded.mp4", func(w http.ResponseWriter, _ *http.Request) {
		file(w, "video/mp4", 98_000)
	})
	mux.HandleFunc("/expired", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "link expired", http.StatusGone)
	})
	mux.HandleFunc("/forbidden", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "forbidden", http.StatusForbidden)
	})
	mux.HandleFunc("/busy", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "slow down", http.StatusTooManyRequests)
	})
	mux.HandleFunc("/broken", func(w http.ResponseWriter, _ *http.Request) {
		http.Error(w, "oops", http.StatusBadGateway)
	})
	mux.HandleFunc("/page", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html; charset=utf-8")
		_, _ = w.Write([]byte("<!doctype html><title>Log in</title>"))
	})
	mux.HandleFunc("/error.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"error":"bad key"}`))
	})
	mux.HandleFunc("/live/index.m3u8", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/plain")
		_, _ = w.Write([]byte("#EXTM3U\n"))
	})
	mux.HandleFunc("/whole.mkv", func(w http.ResponseWriter, _ *http.Request) {
		// Ignores Range and sends the file.
		w.Header().Set("Content-Type", "video/x-matroska")
		w.Header().Set("Content-Length", "40000000")
		_, _ = w.Write(make([]byte, 64<<10))
	})
	mux.HandleFunc("/loop", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/loop", http.StatusFound)
	})
	d.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		d.seen = append(d.seen, r.Header.Clone())
		mux.ServeHTTP(w, r)
	}))
	t.Cleanup(d.Close)
	return d
}

func (d *debrid) resolveURL(reason string) string {
	return d.URL + "/resolve/torbox/" + key + "/" + reason + "/Film.2160p.mkv"
}

func TestResolveFollowsRedirectsToTheFile(t *testing.T) {
	d := newDebrid(t)
	s := NewService("1.2.3")

	got, err := s.Resolve(t.Context(), Request{URL: d.resolveURL("cached")})
	if err != nil {
		t.Fatal(err)
	}
	want := Source{
		URL:         d.URL + "/dld/9b2c?token=" + cdnToken,
		Origin:      d.resolveURL("cached"),
		Headers:     map[string]string{},
		UserAgent:   "Sinag/1.2.3 (+https://github.com/k22i/Sinag)",
		ContentType: "application/octet-stream",
		Size:        7_414_250_351,
	}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Errorf("Resolve =\n %+v\nwant\n %+v", got, want)
	}
	if len(d.seen) != 3 {
		t.Fatalf("requests = %d, want 3 (resolve, requestdl, CDN)", len(d.seen))
	}
	for _, h := range d.seen {
		if h.Get("Range") != "bytes=0-0" || h.Get("User-Agent") != want.UserAgent {
			t.Errorf("headers = %v", h)
		}
		// Go would send the resolve URL, key and all, on to the next host.
		if ref := h.Get("Referer"); strings.Contains(ref, key) {
			t.Errorf("Referer = %q, carries the key", ref)
		}
	}
}

func TestResolveSendsTheAddonsHeaders(t *testing.T) {
	d := newDebrid(t)
	s := NewService("test")

	got, err := s.Resolve(t.Context(), Request{
		URL: d.resolveURL("cached"),
		Headers: map[string]string{
			"referer":    "https://player.example/",
			"user-agent": "Mozilla/5.0 (Addon)",
			"X-Token":    "a, b",
			// Not sent: the player sets these, or they aren't valid.
			"Range":      "bytes=100-",
			"Host":       "elsewhere.example",
			"Bad Name":   "x",
			"X-Injected": "a\r\nEvil: 1",
		},
	})
	if err != nil {
		t.Fatal(err)
	}
	if got.UserAgent != "Mozilla/5.0 (Addon)" {
		t.Errorf("UserAgent = %q", got.UserAgent)
	}
	wantFields := []string{"Referer: https://player.example/", "X-Token: a, b"}
	if fmt.Sprint(got.HeaderFields()) != fmt.Sprint(wantFields) {
		t.Errorf("HeaderFields = %q, want %q", got.HeaderFields(), wantFields)
	}
	// Every hop gets them, the CDN included.
	for _, h := range d.seen {
		if h.Get("Referer") != "https://player.example/" || h.Get("X-Token") != "a, b" ||
			h.Get("User-Agent") != "Mozilla/5.0 (Addon)" || h.Get("Range") != "bytes=0-0" ||
			h.Get("Evil") != "" || h.Get("X-Injected") != "" {
			t.Errorf("headers = %v", h)
		}
	}
}

func TestResolveNamesWhatANoticeSays(t *testing.T) {
	d := newDebrid(t)
	s := NewService("test")
	for url, want := range map[string]error{
		d.resolveURL("downloading_v3"):                          ErrCaching,
		d.resolveURL("failed_access_v2"):                        ErrDenied,
		d.resolveURL("limits_exceeded_v1"):                      ErrBusy,
		d.resolveURL("failed_rar_v2"):                           ErrFailed,
		d.URL + "/static/exceptions/torrent_not_downloaded.mp4": ErrCaching,
	} {
		if _, err := s.Resolve(t.Context(), Request{URL: url}); !errors.Is(err, want) {
			t.Errorf("Resolve(%s) error = %v, want %v", url[len(d.URL):], err, want)
		}
	}
}

func TestResolveSaysWhyALinkWontPlay(t *testing.T) {
	d := newDebrid(t)
	s := NewService("test")
	for path, want := range map[string]error{
		"/expired":    ErrExpired,
		"/forbidden":  ErrExpired,
		"/missing":    ErrExpired,
		"/busy":       ErrBusy,
		"/broken":     ErrUnavailable,
		"/page":       ErrNotVideo,
		"/error.json": ErrNotVideo,
		"/loop":       ErrRedirects,
	} {
		if _, err := s.Resolve(t.Context(), Request{URL: d.URL + path}); !errors.Is(err, want) {
			t.Errorf("Resolve(%s) error = %v, want %v", path, err, want)
		}
	}
}

func TestResolveTakesPlaylistsAndWholeFiles(t *testing.T) {
	d := newDebrid(t)
	s := NewService("test")

	hls, err := s.Resolve(t.Context(), Request{URL: d.URL + "/live/index.m3u8"})
	if err != nil {
		t.Errorf("playlist: %v", err)
	}
	if hls.ContentType != "text/plain" {
		t.Errorf("playlist ContentType = %q", hls.ContentType)
	}
	whole, err := s.Resolve(t.Context(), Request{URL: d.URL + "/whole.mkv"})
	if err != nil || whole.Size != 40_000_000 {
		t.Errorf("whole file = %+v, %v; want size 40000000", whole, err)
	}
}

func TestResolveRefusesOtherSchemes(t *testing.T) {
	s := NewService("test")
	for _, u := range []string{"magnet:?xt=urn:btih:abc", "file:///etc/passwd", "/video.mp4", "http://", "ytid"} {
		if _, err := s.Resolve(t.Context(), Request{URL: u}); !errors.Is(err, ErrInvalidURL) {
			t.Errorf("Resolve(%q) error = %v, want ErrInvalidURL", u, err)
		}
	}
}

func TestResolveErrorsNameNoURL(t *testing.T) {
	stuck := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer stuck.Close()
	closed := httptest.NewServer(http.NotFoundHandler())
	closedURL := closed.URL
	closed.Close()

	s := NewService("test")
	_, err := s.Resolve(t.Context(), Request{URL: closedURL + "/resolve/torbox/" + key + "/x"})
	if !errors.Is(err, ErrUnreachable) || strings.Contains(err.Error(), key) {
		t.Errorf("unreachable: error = %v", err)
	}

	s.maxWait = 50 * time.Millisecond
	_, err = s.Resolve(t.Context(), Request{URL: stuck.URL + "/resolve/torbox/" + key + "/x"})
	if !errors.Is(err, ErrTimeout) || strings.Contains(err.Error(), key) {
		t.Errorf("timeout: error = %v", err)
	}
	if code := string(MarshalError(err)); code != `{"code":"timeout"}` {
		t.Errorf("MarshalError = %s", code)
	}
}

func TestResolveStopsWhenCancelled(t *testing.T) {
	started := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(t.Context())
	go func() {
		<-started
		cancel()
	}()
	if _, err := NewService("test").Resolve(ctx, Request{URL: srv.URL}); !errors.Is(err, context.Canceled) {
		t.Errorf("error = %v, want context.Canceled", err)
	}
}

func TestMarshalError(t *testing.T) {
	for err, want := range map[error]string{
		ErrInvalidURL:    CodeInvalidURL,
		ErrUnreachable:   CodeUnreachable,
		ErrTimeout:       CodeTimeout,
		ErrRedirects:     CodeRedirects,
		ErrExpired:       CodeExpired,
		ErrBusy:          CodeBusy,
		ErrUnavailable:   CodeUnavailable,
		ErrNotVideo:      CodeNotVideo,
		ErrCaching:       CodeCaching,
		ErrDenied:        CodeDenied,
		ErrFailed:        CodeFailed,
		context.Canceled: CodeUnreachable,
	} {
		var got struct{ Code string }
		if err := json.Unmarshal(MarshalError(err), &got); err != nil || got.Code != want {
			t.Errorf("MarshalError(%v) = %+v, want %q", err, got, want)
		}
	}
}
