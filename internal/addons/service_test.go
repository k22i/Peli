package addons

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

func TestFetchPassesAnswersOn(t *testing.T) {
	var userAgent string
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		userAgent = r.Header.Get("User-Agent")
		// No Access-Control-Allow-Origin: what the webview can't read.
		if r.URL.Path == "/missing.json" {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"id":"org.example","name":"Example","version":"1.0.0"}`))
	}))
	defer srv.Close()
	s := NewService("1.2.3")

	got, err := s.Fetch(t.Context(), srv.URL+"/manifest.json")
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != 200 || !strings.Contains(got.Body, `"org.example"`) {
		t.Errorf("Fetch = %+v", got)
	}
	if userAgent != "Sinag/1.2.3 (+https://github.com/k22i/Sinag)" {
		t.Errorf("User-Agent = %q", userAgent)
	}

	got, err = s.Fetch(t.Context(), srv.URL+"/missing.json")
	if err != nil || got.Status != 404 {
		t.Errorf("Fetch(missing) = %+v, %v; want status 404 and no error", got, err)
	}
}

func TestFetchRefusesOtherSchemes(t *testing.T) {
	s := NewService("test")
	for _, u := range []string{"file:///etc/passwd", "stremio://addon.example/manifest.json", "/manifest.json", "http://"} {
		if _, err := s.Fetch(t.Context(), u); !errors.Is(err, ErrInvalidURL) {
			t.Errorf("Fetch(%q) error = %v, want ErrInvalidURL", u, err)
		}
	}
}

func TestFetchCapsTheBody(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write(make([]byte, MaxBody+1))
	}))
	defer srv.Close()
	if _, err := NewService("test").Fetch(t.Context(), srv.URL); !errors.Is(err, ErrTooLarge) {
		t.Errorf("error = %v, want ErrTooLarge", err)
	}
}

func TestFetchErrorsNameNoURL(t *testing.T) {
	// The config segment can hold a debrid key.
	const secret = "torbox=0123456789abcdef"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		<-r.Context().Done()
	}))
	defer srv.Close()

	s := NewService("test")
	closed := httptest.NewServer(http.NotFoundHandler())
	closedURL := closed.URL
	closed.Close()
	_, err := s.Fetch(t.Context(), closedURL+"/"+secret+"/manifest.json")
	if !errors.Is(err, ErrUnreachable) || strings.Contains(err.Error(), secret) {
		t.Errorf("unreachable: error = %v", err)
	}

	s.maxWait = 50 * time.Millisecond
	_, err = s.Fetch(t.Context(), srv.URL+"/"+secret+"/stream/movie/tt1.json")
	if !errors.Is(err, ErrTimeout) || strings.Contains(err.Error(), secret) {
		t.Errorf("timeout: error = %v", err)
	}
	if code := string(MarshalError(err)); code != `{"code":"timeout"}` {
		t.Errorf("MarshalError = %s", code)
	}
}

func TestFetchStopsWhenCancelled(t *testing.T) {
	started := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		<-r.Context().Done()
	}))
	defer srv.Close()

	ctx, cancel := context.WithCancel(t.Context())
	go func() {
		<-started
		cancel()
	}()
	if _, err := NewService("test").Fetch(ctx, srv.URL); !errors.Is(err, context.Canceled) {
		t.Errorf("error = %v, want context.Canceled", err)
	}
}

func TestMarshalError(t *testing.T) {
	for err, want := range map[error]string{
		ErrInvalidURL:    CodeInvalidURL,
		ErrUnreachable:   CodeUnreachable,
		ErrTimeout:       CodeTimeout,
		ErrTooLarge:      CodeTooLarge,
		context.Canceled: CodeUnreachable,
	} {
		var got struct{ Code string }
		if err := json.Unmarshal(MarshalError(err), &got); err != nil || got.Code != want {
			t.Errorf("MarshalError(%v) = %+v, want %q", err, got, want)
		}
	}
}
