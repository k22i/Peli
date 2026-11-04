package plugins

import (
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
)

func TestServiceStreams(t *testing.T) {
	var asked atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/manifest.json":
			fmt.Fprint(w, `[{"id": "echo", "name": "Echo", "filename": "echo.js", "enabled": true, "supportedTypes": ["movie", "tv"]},
				{"id": "off", "filename": "off.js", "enabled": false}]`)
		case "/echo.js":
			asked.Add(1)
			fmt.Fprint(w, `module.exports = { getStreams: (id, type, s, e) => [{ name: SCRAPER_ID, title: [id, type, s, e].join(" "), url: "https://cdn.test/" + id }] };`)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	s := NewService("test")
	t.Setenv(DevManifestEnv, server.URL+"/manifest.json")
	installed, err := s.Installed(t.Context())
	if err != nil {
		t.Fatal(err)
	}
	if len(installed) != 1 || installed[0].ID != "echo" || installed[0].URL != server.URL+"/echo.js" {
		t.Fatalf("installed %+v", installed)
	}

	for range 2 {
		streams, err := s.Streams(t.Context(), installed[0], Query{TmdbID: "1396", MediaType: "tv", Season: 1, Episode: 2})
		if err != nil {
			t.Fatal(err)
		}
		if len(streams) != 1 || streams[0].Name != "echo" || streams[0].Title != "1396 tv 1 2" {
			t.Errorf("got %+v", streams)
		}
	}
	if asked.Load() != 1 {
		t.Errorf("code downloaded %d times, want once", asked.Load())
	}

	// A film is asked without a season or episode.
	streams, err := s.Streams(t.Context(), installed[0], Query{TmdbID: "550", MediaType: "movie", Season: 3, Episode: 4})
	if err != nil || streams[0].Title != "550 movie" {
		t.Errorf("film: %+v, %v", streams, err)
	}

	if _, err := s.Streams(t.Context(), Plugin{ID: "gone", URL: server.URL + "/gone.js"}, Query{TmdbID: "550", MediaType: "movie"}); !errors.Is(err, ErrUnreachable) {
		t.Errorf("missing code: %v", err)
	}
	if _, err := s.Streams(t.Context(), installed[0], Query{MediaType: "movie"}); err == nil {
		t.Error("no TMDB id was asked")
	}
}

func TestInstalledWithoutManifest(t *testing.T) {
	t.Setenv(DevManifestEnv, "")
	installed, err := NewService("test").Installed(t.Context())
	if err != nil || installed == nil || len(installed) != 0 {
		t.Errorf("got %v, %v", installed, err)
	}
}

func TestMarshalError(t *testing.T) {
	for err, want := range map[error]string{
		ErrTimeout:                     `{"code":"timeout"}`,
		ErrMemory:                      `{"code":"memory"}`,
		fmt.Errorf("%w: x", ErrFailed): `{"code":"failed"}`,
		ErrInvalidPlugin:               `{"code":"invalid_plugin"}`,
		ErrUnreachable:                 `{"code":"unreachable"}`,
		ErrCrashed:                     `{"code":"crashed"}`,
		ErrStalled:                     `{"code":"stalled"}`,
		ErrBadAnswer:                   `{"code":"bad_answer"}`,
		errors.New("something else"):   `{"code":"failed"}`,
	} {
		if got := string(MarshalError(err)); got != want {
			t.Errorf("%v: got %s, want %s", err, got, want)
		}
	}
}
