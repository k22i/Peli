package plugins

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"slices"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/k22i/Sinag/internal/store"
)

// repository serves a plugin repository over HTTP: a manifest with an
// enabled plugin "echo", one the manifest has off, and echo's code, which
// answers with what it was asked. asked counts downloads of echo's code.
func repository(t *testing.T) (server *httptest.Server, asked *atomic.Int32) {
	t.Helper()
	asked = new(atomic.Int32)
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/repo/manifest.json":
			fmt.Fprint(w, `{"name": "Test repo", "version": "1", "scrapers": [
				{"id": "echo", "name": "Echo", "filename": "echo.js", "enabled": true, "supportedTypes": ["movie", "tv"]},
				{"id": "off", "filename": "off.js", "enabled": false},
				{"id": "phone", "filename": "phone.js", "enabled": true, "disabledPlatforms": ["desktop"]}]}`)
		case "/empty/manifest.json":
			fmt.Fprint(w, `[]`)
		case "/junk/manifest.json":
			fmt.Fprint(w, `<html>not json</html>`)
		case "/repo/echo.js":
			asked.Add(1)
			fmt.Fprint(w, `module.exports = { getStreams: (id, type, s, e) => [{ name: SCRAPER_ID, title: [id, type, s, e].join(" ") + " " + (SCRAPER_SETTINGS.quality || ""), url: "https://cdn.test/" + id }] };`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(server.Close)
	return server, asked
}

// host is a Service on a fresh store with a profile in use, the way main
// wires it; the editor only checks nothing, like an unlocked ordinary profile.
type host struct {
	*Service
	db      *store.Store
	profile store.Profile
	kids    store.Profile
}

func newHost(t *testing.T) *host {
	t.Helper()
	db, err := store.Open(filepath.Join(t.TempDir(), "sinag.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { db.Close() })
	profile, err := db.CreateProfile(store.Profile{Name: "Kevin"})
	if err != nil {
		t.Fatal(err)
	}
	kids, err := db.CreateProfile(store.Profile{Name: "Kids", Kids: true})
	if err != nil {
		t.Fatal(err)
	}
	if err := db.SetCurrentProfile(profile.ID); err != nil {
		t.Fatal(err)
	}
	s := NewService("test")
	UseStore(s, func() *store.Store { return db }, func(_ uint64, edit func(*store.Store) error) error { return edit(db) })
	return &host{Service: s, db: db, profile: profile, kids: kids}
}

func ids(list []Plugin) []string {
	out := []string{}
	for _, p := range list {
		out = append(out, p.ID)
	}
	return out
}

// Nothing is installed, and nothing is asked, until a repository is added and
// the master switch is on (#57).
func TestInstalledIsOffByDefault(t *testing.T) {
	server, asked := repository(t)
	h := newHost(t)
	ctx := t.Context()

	installed, err := h.Installed(ctx)
	if err != nil || installed == nil || len(installed) != 0 {
		t.Fatalf("a new profile: %v, %v", installed, err)
	}
	// Installing, refreshing and asking all refuse while plugins are off,
	// and make no request.
	if _, err := h.InstallRepository(ctx, h.profile.ID, server.URL+"/repo"); !errors.Is(err, ErrOff) {
		t.Fatalf("installing while off: %v", err)
	}
	if n, err := h.Refresh(ctx, h.profile.ID, true); n != 0 || err != nil {
		t.Fatalf("refreshing while off: %d, %v", n, err)
	}

	if err := h.SetEnabled(ctx, h.profile.ID, true); err != nil {
		t.Fatal(err)
	}
	if _, err := h.InstallRepository(ctx, h.profile.ID, server.URL+"/repo"); err != nil {
		t.Fatal(err)
	}
	installed, err = h.Installed(ctx)
	if err != nil || !slices.Equal(ids(installed), []string{"echo"}) || installed[0].URL != server.URL+"/repo/echo.js" {
		t.Fatalf("on: %+v, %v", installed, err)
	}
	if _, err := h.Streams(ctx, installed[0], Query{TmdbID: "1", MediaType: "movie"}); err != nil {
		t.Fatal(err)
	}

	// Off again: nothing is listed, and asking a plugin the caller names
	// is refused, so a stale frontend can't run one.
	if err := h.SetEnabled(ctx, h.profile.ID, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := h.Installed(ctx); len(got) != 0 {
		t.Fatalf("off again: %+v", got)
	}
	if _, err := h.Streams(ctx, Plugin{ID: "echo", URL: server.URL + "/repo/echo.js"}, Query{TmdbID: "1", MediaType: "movie"}); !errors.Is(err, ErrNotEnabled) {
		t.Fatalf("asking while off: %v", err)
	}
	if asked.Load() != 1 {
		t.Fatalf("code downloaded %d times, want once", asked.Load())
	}
}

// A kids profile never has plugins: not listed, not changed, not asked, and
// the settings pane is told so (ADR-0047).
func TestKidsProfilesNeverRunPlugins(t *testing.T) {
	server, _ := repository(t)
	h := newHost(t)
	ctx := t.Context()
	if err := h.SetEnabled(ctx, h.profile.ID, true); err != nil {
		t.Fatal(err)
	}
	installed, err := h.InstallRepository(ctx, h.profile.ID, server.URL+"/repo")
	if err != nil {
		t.Fatal(err)
	}
	list, _ := h.Installed(ctx)
	if len(list) != 1 {
		t.Fatalf("an ordinary profile: %+v", list)
	}

	// The same switch and list, on a kids profile that is in use.
	if err := h.db.SetPluginsEnabled(h.kids.ID, true); err != nil {
		t.Fatal(err)
	}
	if err := h.db.InstallPluginRepo(h.kids.ID, store.PluginRepo{URL: installed.URL, Enabled: true}, store.PluginCache{Plugins: []store.PluginEntry{{ID: "echo", File: list[0].URL, Enabled: true}}}); err != nil {
		t.Fatal(err)
	}
	if err := h.db.SetCurrentProfile(h.kids.ID); err != nil {
		t.Fatal(err)
	}
	if got, err := h.Installed(ctx); err != nil || len(got) != 0 {
		t.Fatalf("kids profile in use: %+v, %v", got, err)
	}
	if _, err := h.Streams(ctx, list[0], Query{TmdbID: "1", MediaType: "movie"}); !errors.Is(err, ErrNotEnabled) {
		t.Fatalf("asking on a kids profile: %v", err)
	}
	overview, err := h.Overview(ctx, h.kids.ID)
	if err != nil || !overview.Kids || overview.Enabled || len(overview.Repositories) != 0 {
		t.Fatalf("kids overview = %+v, %v", overview, err)
	}
	for name, err := range map[string]error{
		"enable":  h.SetEnabled(ctx, h.kids.ID, false),
		"remove":  h.RemoveRepository(ctx, h.kids.ID, installed.URL),
		"plugin":  h.EnablePlugin(ctx, h.kids.ID, "echo", false),
		"repo":    h.EnableRepository(ctx, h.kids.ID, installed.URL, false),
		"setting": h.SetSettings(ctx, h.kids.ID, "echo", nil),
	} {
		if !errors.Is(err, ErrKids) {
			t.Errorf("%s on a kids profile: %v", name, err)
		}
	}
	if _, err := h.InstallRepository(ctx, h.kids.ID, server.URL+"/other"); !errors.Is(err, ErrKids) {
		t.Fatalf("installing on a kids profile: %v", err)
	}
	if n, err := h.Refresh(ctx, h.kids.ID, true); n != 0 || err != nil {
		t.Fatalf("refreshing a kids profile: %d, %v", n, err)
	}
}

// The master switch is per profile.
func TestPluginSwitchIsPerProfile(t *testing.T) {
	h := newHost(t)
	other, err := h.db.CreateProfile(store.Profile{Name: "Other"})
	if err != nil {
		t.Fatal(err)
	}
	if err := h.SetEnabled(t.Context(), h.profile.ID, true); err != nil {
		t.Fatal(err)
	}
	on, _ := h.Overview(t.Context(), h.profile.ID)
	off, _ := h.Overview(t.Context(), other.ID)
	if !on.Enabled || off.Enabled {
		t.Fatalf("on = %+v, off = %+v", on, off)
	}
}

func TestInstallRepository(t *testing.T) {
	server, _ := repository(t)
	h := newHost(t)
	ctx := t.Context()
	if err := h.SetEnabled(ctx, h.profile.ID, true); err != nil {
		t.Fatal(err)
	}

	// A bare address finds the manifest, and the source is shown.
	repo, err := h.InstallRepository(ctx, h.profile.ID, server.URL+"/repo/")
	if err != nil {
		t.Fatal(err)
	}
	if repo.URL != server.URL+"/repo/manifest.json" || repo.Name != "Test repo" || !repo.Enabled || !repo.Supported {
		t.Fatalf("repository = %+v", repo)
	}
	// Not "phone": the manifest turns it off for desktop. "off" is listed, off.
	if len(repo.Plugins) != 2 || repo.Plugins[0].ID != "echo" || !repo.Plugins[0].Enabled || repo.Plugins[1].ID != "off" || repo.Plugins[1].Enabled {
		t.Fatalf("plugins = %+v", repo.Plugins)
	}

	if _, err := h.InstallRepository(ctx, h.profile.ID, server.URL+"/repo/manifest.json"); !errors.Is(err, store.ErrPluginRepoInstalled) {
		t.Fatalf("installing twice: %v", err)
	}
	for path, want := range map[string]error{
		"/empty":                 ErrNotRepository,
		"/junk/manifest.json":    ErrNotRepository,
		"/missing/manifest.json": ErrUnreachable,
	} {
		if _, err := h.InstallRepository(ctx, h.profile.ID, server.URL+path); !errors.Is(err, want) {
			t.Errorf("%s: %v, want %v", path, err, want)
		}
	}
	for _, bad := range []string{"", "  ", "ftp://x/manifest.json", "https://user:pw@x/m.json"} {
		if _, err := h.InstallRepository(ctx, h.profile.ID, bad); !errors.Is(err, ErrBadAddress) {
			t.Errorf("%q: %v", bad, err)
		}
	}
	overview, err := h.Overview(ctx, h.profile.ID)
	if err != nil || !overview.Enabled || len(overview.Repositories) != 1 {
		t.Fatalf("overview = %+v, %v", overview, err)
	}

	// Nothing failed was kept, and the repository is in the synced list.
	repos, _ := h.db.PluginRepos(h.profile.ID)
	if len(repos) != 1 || repos[0].Type != store.PluginTypeJS {
		t.Fatalf("stored = %+v", repos)
	}

	// Turn a plugin on and the repository off and on, then remove it.
	if err := h.EnablePlugin(ctx, h.profile.ID, "off", true); err != nil {
		t.Fatal(err)
	}
	if got, _ := h.Installed(ctx); !slices.Equal(ids(got), []string{"echo", "off"}) {
		t.Fatalf("after enabling: %v", ids(got))
	}
	if err := h.EnableRepository(ctx, h.profile.ID, repo.URL, false); err != nil {
		t.Fatal(err)
	}
	if got, _ := h.Installed(ctx); len(got) != 0 {
		t.Fatalf("repository off: %v", ids(got))
	}
	if err := h.RemoveRepository(ctx, h.profile.ID, repo.URL); err != nil {
		t.Fatal(err)
	}
	if err := h.RemoveRepository(ctx, h.profile.ID, repo.URL); !errors.Is(err, store.ErrPluginRepoNotFound) {
		t.Fatalf("removing twice: %v", err)
	}
	if overview, _ := h.Overview(ctx, h.profile.ID); len(overview.Repositories) != 0 {
		t.Fatalf("after removing: %+v", overview)
	}
}

func TestManifestAddress(t *testing.T) {
	for in, want := range map[string]string{
		"https://x.example/repo":               "https://x.example/repo/manifest.json",
		"https://x.example/repo/":              "https://x.example/repo/manifest.json",
		"x.example/repo":                       "https://x.example/repo/manifest.json",
		"https://x.example":                    "https://x.example/manifest.json",
		"https://x.example/repo/manifest.json": "https://x.example/repo/manifest.json",
		"https://x.example/plugins.json?v=2#a": "https://x.example/plugins.json?v=2",
		"  http://x.example/repo  ":            "http://x.example/repo/manifest.json",
	} {
		got, err := manifestAddress(in)
		if err != nil || got != want {
			t.Errorf("%q → %q, %v; want %q", in, got, err, want)
		}
	}
}

// Plugins that came from Nuvio have no list here until Refresh reads their
// manifests; a plugin keeps its settings, and they reach the sandbox as
// SCRAPER_SETTINGS.
func TestRefreshAndSettings(t *testing.T) {
	server, _ := repository(t)
	h := newHost(t)
	ctx := t.Context()
	if err := h.SetEnabled(ctx, h.profile.ID, true); err != nil {
		t.Fatal(err)
	}
	link := server.URL + "/repo/manifest.json"
	// The repository arrives from a pull: in the list, with no plugins yet.
	item, _ := json.Marshal([]store.PluginRepo{{URL: link, Name: "From Nuvio", Enabled: true}, {URL: "https://x/repo.cs3", Enabled: true, Type: "EXTERNAL_DEX"}})
	if _, err := h.db.ApplyChanges(h.profile.ID, []store.Change{{Surface: store.SurfacePlugins, Op: store.OpUpsert, Item: item}}); err != nil {
		t.Fatal(err)
	}
	if got, _ := h.Installed(ctx); len(got) != 0 {
		t.Fatalf("before the first refresh: %v", ids(got))
	}
	n, err := h.Refresh(ctx, h.profile.ID, false)
	if err != nil || n != 1 {
		t.Fatalf("refresh = %d, %v; want the one repository Sinag can run", n, err)
	}
	if n, err := h.Refresh(ctx, h.profile.ID, false); err != nil || n != 0 {
		t.Fatalf("a second refresh = %d, %v; want nothing due", n, err)
	}
	overview, _ := h.Overview(ctx, h.profile.ID)
	if overview.Repositories[0].Name != "From Nuvio" || overview.Repositories[1].Supported {
		t.Fatalf("overview = %+v", overview.Repositories)
	}

	if err := h.SetSettings(ctx, h.profile.ID, "echo", map[string]any{"quality": "4k"}); err != nil {
		t.Fatal(err)
	}
	installed, _ := h.Installed(ctx)
	if len(installed) != 1 || installed[0].Settings["quality"] != "4k" {
		t.Fatalf("installed = %+v", installed)
	}
	// The caller's settings aren't used, the stored ones are.
	forged := installed[0]
	forged.Settings = map[string]any{"quality": "forged"}
	streams, err := h.Streams(ctx, forged, Query{TmdbID: "1396", MediaType: "tv", Season: 1, Episode: 2})
	if err != nil {
		t.Fatal(err)
	}
	if len(streams) != 1 || streams[0].Name != "echo" || streams[0].Title != "1396 tv 1 2 4k" {
		t.Fatalf("streams = %+v", streams)
	}
	// A film is asked without a season or episode.
	streams, err = h.Streams(ctx, installed[0], Query{TmdbID: "550", MediaType: "movie", Season: 3, Episode: 4})
	if err != nil || len(streams) != 1 || !strings.HasPrefix(streams[0].Title, "550 movie") || strings.Contains(streams[0].Title, "3") || !strings.HasSuffix(streams[0].Title, "4k") {
		t.Fatalf("film: %+v, %v", streams, err)
	}
	if _, err := h.Streams(ctx, installed[0], Query{MediaType: "movie"}); err == nil {
		t.Error("no TMDB id was asked")
	}
}

// With no store set, nothing is installed and nothing runs.
func TestNoStoreMeansNoPlugins(t *testing.T) {
	s := NewService("test")
	installed, err := s.Installed(t.Context())
	if err != nil || installed == nil || len(installed) != 0 {
		t.Fatalf("got %v, %v", installed, err)
	}
	if _, err := s.Streams(t.Context(), Plugin{ID: "x", URL: "https://x/x.js"}, Query{TmdbID: "1", MediaType: "movie"}); !errors.Is(err, ErrNotEnabled) {
		t.Fatalf("Streams: %v", err)
	}
	if _, err := s.Overview(t.Context(), 1); !errors.Is(err, ErrNoStore) {
		t.Fatalf("Overview: %v", err)
	}
}

// The code of a plugin is downloaded once, then kept for a while.
func TestRunUncheckedCachesCode(t *testing.T) {
	server, asked := repository(t)
	s := NewService("test")
	plugin := Plugin{ID: "echo", URL: server.URL + "/repo/echo.js"}
	for range 2 {
		if _, err := RunUnchecked(t.Context(), s, plugin, Query{TmdbID: "1", MediaType: "movie"}); err != nil {
			t.Fatal(err)
		}
	}
	if asked.Load() != 1 {
		t.Errorf("code downloaded %d times, want once", asked.Load())
	}
	if _, err := RunUnchecked(t.Context(), s, Plugin{ID: "gone", URL: server.URL + "/gone.js"}, Query{TmdbID: "550", MediaType: "movie"}); !errors.Is(err, ErrUnreachable) {
		t.Errorf("missing code: %v", err)
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
		ErrKids:                        `{"code":"kids_profile"}`,
		ErrOff:                         `{"code":"off"}`,
		ErrNotEnabled:                  `{"code":"not_enabled"}`,
		ErrNotRepository:               `{"code":"not_a_repository"}`,
		ErrBadAddress:                  `{"code":"bad_address"}`,
		store.ErrPluginRepoInstalled:   `{"code":"already_installed"}`,
		store.ErrPluginRepoNotFound:    `{"code":"not_found"}`,
		ErrStalled:                     `{"code":"stalled"}`,
		ErrBadAnswer:                   `{"code":"bad_answer"}`,
		errors.New("something else"):   `{"code":"failed"}`,
	} {
		if got := string(MarshalError(err)); got != want {
			t.Errorf("%v: got %s, want %s", err, got, want)
		}
	}
}
