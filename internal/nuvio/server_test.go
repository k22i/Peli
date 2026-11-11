package nuvio

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/k22i/Peli/internal/nuvio/nuviotest"
)

func TestUseServer(t *testing.T) {
	first, second := nuviotest.NewServer(t), nuviotest.NewServer(t)
	c := newTestClient(first.URL)
	if _, err := c.AvatarCatalog(t.Context()); err != nil {
		t.Fatal(err)
	}

	c.UseServer(second.URL+"/", "")
	if got := c.ServerURL(); got != second.URL {
		t.Fatalf("ServerURL = %q, want %q", got, second.URL)
	}
	if _, err := c.AvatarCatalog(t.Context()); err != nil {
		t.Fatal(err)
	}
	if n := len(first.Calls()); n != 1 {
		t.Fatalf("first server: %d calls, want 1", n)
	}
	if n := len(second.Calls()); n != 1 {
		t.Fatalf("second server: %d calls, want 1", n)
	}
	if got := c.AvatarImageURL(Avatar{Path: "a.png"}); got != second.URL+"/storage/v1/object/public/avatars/a.png" {
		t.Fatalf("avatar image = %q", got)
	}

	// A key that is given is used, not the discovered one.
	c.UseServer(first.URL, "someone-elses")
	if _, err := c.AvatarCatalog(t.Context()); !errors.Is(err, ErrSignedOut) {
		t.Fatalf("err = %v, want the fake's 401 for a wrong key", err)
	}
	c.UseServer(first.URL, nuviotest.Key)
	if _, err := c.AvatarCatalog(t.Context()); err != nil {
		t.Fatal(err)
	}
}

func TestCheckServer(t *testing.T) {
	nuvio := nuviotest.NewServer(t)
	notFound := httptest.NewServer(http.NotFoundHandler())
	t.Cleanup(notFound.Close)
	webPage := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "text/html")
		w.Write([]byte("<!doctype html><title>Home</title>"))
	}))
	t.Cleanup(webPage.Close)
	gone := httptest.NewServer(http.NotFoundHandler())
	gone.Close()

	for _, tc := range []struct {
		name, url, key string
		want           error
	}{
		{"discovered key", nuvio.URL, "", nil},
		{"given key", nuvio.URL, nuviotest.Key, nil},
		{"wrong key", nuvio.URL, "wrong", ErrKeyRefused},
		{"no discovery", notFound.URL, "", ErrNotNuvio},
		{"no Nuvio functions", notFound.URL, "some-key", ErrNotNuvio},
		{"a web page", webPage.URL, "", ErrNotNuvio},
		{"unreachable", gone.URL, "", ErrUnreachable},
	} {
		t.Run(tc.name, func(t *testing.T) {
			c := newTestClient(nuvio.URL)
			err := c.CheckServer(t.Context(), tc.url, tc.key)
			if tc.want == nil && err != nil || tc.want != nil && !errors.Is(err, tc.want) {
				t.Fatalf("err = %v, want %v", err, tc.want)
			}
			if c.ServerURL() != nuvio.URL {
				t.Fatalf("the client moved to %q", c.ServerURL())
			}
		})
	}
}

func TestParseServerURL(t *testing.T) {
	for raw, want := range map[string]string{
		"https://nuvio.example.com":       "https://nuvio.example.com",
		" https://Nuvio.Example.com/ ":    "https://nuvio.example.com",
		"http://192.168.1.20:8000":        "http://192.168.1.20:8000",
		"https://example.com/nuvio/":      "https://example.com/nuvio",
		"nuvio.example.com":               "",
		"ftp://nuvio.example.com":         "",
		"https://":                        "",
		"https://me:pw@nuvio.example.com": "",
		"https://nuvio.example.com/?a=1":  "",
		"https://nuvio.example.com/#top":  "",
		"":                                "",
	} {
		got, err := ParseServerURL(raw)
		if want == "" {
			if err == nil {
				t.Errorf("ParseServerURL(%q) = %q, want an error", raw, got)
			}
			continue
		}
		if err != nil || got != want {
			t.Errorf("ParseServerURL(%q) = %q, %v; want %q", raw, got, err, want)
		}
	}
}
