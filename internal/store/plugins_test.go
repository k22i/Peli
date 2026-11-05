package store

import (
	"encoding/json"
	"errors"
	"testing"
)

var (
	repoA = PluginRepo{URL: "https://a.example/manifest.json", Name: "A", Enabled: true, Type: PluginTypeJS}
	repoB = PluginRepo{URL: "https://b.example/manifest.json", Name: "B", Enabled: true, Type: PluginTypeJS}
	alpha = PluginEntry{ID: "alpha", Name: "Alpha", File: "https://a.example/alpha.js", SupportedTypes: []string{"movie"}, Enabled: true}
	beta  = PluginEntry{ID: "beta", Name: "Beta", File: "https://a.example/beta.js", SupportedTypes: []string{"movie", "tv"}, Enabled: false}
)

func pluginsPush(t *testing.T, s *Store, id uint64) (list, base []PluginRepo) {
	t.Helper()
	var found *Push
	for _, p := range must[[]Push](t)(s.Pending(id)) {
		if p.Surface == SurfacePlugins {
			if found != nil {
				t.Fatal("two plugins pushes queued")
			}
			found = &p
		}
	}
	if found == nil {
		t.Fatal("no plugins push queued")
	}
	check(t, json.Unmarshal(found.Item, &list))
	check(t, json.Unmarshal(found.Base, &base))
	return list, base
}

// Plugins are off, with nothing installed, until the profile says so (#57).
func TestPluginsAreOffByDefault(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	config := must[PluginConfig](t)(s.PluginConfig(p.ID))
	if config.Enabled || len(config.Caches) != 0 {
		t.Fatalf("a new profile's plugin config = %+v", config)
	}
	equal(t, must[[]PluginRepo](t)(s.PluginRepos(p.ID)), []PluginRepo{})

	check(t, s.SetPluginsEnabled(p.ID, true))
	if !must[PluginConfig](t)(s.PluginConfig(p.ID)).Enabled {
		t.Fatal("the switch didn't turn on")
	}
	// The switch is per profile.
	other := must[Profile](t)(s.CreateProfile(Profile{Name: "Other", NuvioIndex: ptr(2)}))
	if must[PluginConfig](t)(s.PluginConfig(other.ID)).Enabled {
		t.Fatal("the switch turned on for another profile")
	}
	check(t, s.SetPluginsEnabled(p.ID, false))
	if must[PluginConfig](t)(s.PluginConfig(p.ID)).Enabled {
		t.Fatal("the switch didn't turn off")
	}
}

// Repository edits change the stored list and queue the whole new list, with
// the list the backend last had as its base; plugin edits queue nothing,
// since Nuvio has nowhere to put them.
func TestPluginRepoEdits(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	id := p.ID
	cache := PluginCache{Name: "A", Plugins: []PluginEntry{alpha, beta}}

	check(t, s.InstallPluginRepo(id, repoA, cache))
	check(t, s.InstallPluginRepo(id, repoB, PluginCache{}))
	if err := s.InstallPluginRepo(id, repoA, cache); !errors.Is(err, ErrPluginRepoInstalled) {
		t.Fatalf("installing twice: err = %v", err)
	}
	if err := s.InstallPluginRepo(id, PluginRepo{Name: "No URL"}, cache); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("installing without a URL: err = %v", err)
	}
	check(t, s.EnablePluginRepo(id, repoB.URL, false))
	off := repoB
	off.Enabled = false
	equal(t, must[[]PluginRepo](t)(s.PluginRepos(id)), []PluginRepo{repoA, off})

	got := must[PluginConfig](t)(s.PluginConfig(id))
	equal(t, got.Caches[repoA.URL].Plugins, []PluginEntry{alpha, beta})

	list, base := pluginsPush(t, s, id)
	equal(t, list, []PluginRepo{repoA, off})
	equal(t, base, []PluginRepo{})

	// Plugin-level edits are local.
	before := len(must[[]Push](t)(s.Pending(id)))
	seq := must[[]Push](t)(s.Pending(id))[0].Seq
	check(t, s.EnablePlugin(id, "beta", true))
	check(t, s.SetPluginSettings(id, "alpha", map[string]any{"quality": "1080p"}))
	pending := must[[]Push](t)(s.Pending(id))
	if len(pending) != before || pending[0].Seq != seq {
		t.Fatalf("plugin edits queued pushes: %+v", pending)
	}
	got = must[PluginConfig](t)(s.PluginConfig(id))
	plugins := got.Caches[repoA.URL].Plugins
	if !plugins[1].Enabled || plugins[0].Settings["quality"] != "1080p" {
		t.Fatalf("plugins = %+v", plugins)
	}
	check(t, s.SetPluginSettings(id, "alpha", nil))
	if got = must[PluginConfig](t)(s.PluginConfig(id)); got.Caches[repoA.URL].Plugins[0].Settings != nil {
		t.Fatal("settings weren't cleared")
	}
	if err := s.EnablePlugin(id, "nope", true); !errors.Is(err, ErrPluginNotFound) {
		t.Fatalf("a plugin that isn't there: err = %v", err)
	}

	check(t, s.RemovePluginRepo(id, repoA.URL))
	if err := s.RemovePluginRepo(id, repoA.URL); !errors.Is(err, ErrPluginRepoNotFound) {
		t.Fatalf("removing twice: err = %v", err)
	}
	if err := s.EnablePluginRepo(id, repoA.URL, true); !errors.Is(err, ErrPluginRepoNotFound) {
		t.Fatalf("enabling a removed one: err = %v", err)
	}
	if _, ok := must[PluginConfig](t)(s.PluginConfig(id)).Caches[repoA.URL]; ok {
		t.Fatal("a removed repository kept its plugins")
	}
}

// Reading a repository's manifest again keeps what the user chose and adds
// what is new, and doesn't queue a push.
func TestSetPluginCacheKeepsChoices(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	id := p.ID
	check(t, s.InstallPluginRepo(id, repoA, PluginCache{Plugins: []PluginEntry{alpha, beta}}))
	check(t, s.EnablePlugin(id, "alpha", false))
	check(t, s.SetPluginSettings(id, "alpha", map[string]any{"k": "v"}))
	pushes := len(must[[]Push](t)(s.Pending(id)))

	gamma := PluginEntry{ID: "gamma", Name: "Gamma", File: "https://a.example/gamma.js", Enabled: true}
	newAlpha := alpha // the manifest says it's on again, at a new version
	newAlpha.Version = "2"
	check(t, s.SetPluginCache(id, repoA.URL, PluginCache{Version: "9", FetchedAt: 5, Plugins: []PluginEntry{newAlpha, gamma}}))

	got := must[PluginConfig](t)(s.PluginConfig(id)).Caches[repoA.URL]
	if got.Version != "9" || got.FetchedAt != 5 || len(got.Plugins) != 2 {
		t.Fatalf("cache = %+v", got)
	}
	if got.Plugins[0].Enabled || got.Plugins[0].Version != "2" || got.Plugins[0].Settings["k"] != "v" {
		t.Fatalf("alpha = %+v, want the new version with the user's choices", got.Plugins[0])
	}
	if !got.Plugins[1].Enabled {
		t.Fatalf("gamma = %+v, want the manifest's setting", got.Plugins[1])
	}
	if n := len(must[[]Push](t)(s.Pending(id))); n != pushes {
		t.Fatalf("refreshing queued %d new pushes", n-pushes)
	}
	if err := s.SetPluginCache(id, "https://nope/manifest.json", PluginCache{}); !errors.Is(err, ErrPluginRepoNotFound) {
		t.Fatalf("caching for a repository that isn't there: err = %v", err)
	}
}

func TestPluginRepoRunnable(t *testing.T) {
	for r, want := range map[PluginRepo]bool{
		{URL: "https://a/manifest.json", Type: "NUVIO_JS"}:     true,
		{URL: "https://a/manifest.json"}:                       true, // an older client sent no type
		{URL: "https://a/manifest.json", Type: "js"}:           true,
		{URL: "https://a/manifest.json", Type: "EXTERNAL_DEX"}: false,
		{URL: "https://a/manifest.json", Type: "external dex"}: false,
		{URL: "https://a/manifest.json", Type: "LEGACY"}:       false,
		{URL: "https://a/repo.cs3"}:                            false,
		{URL: "https://a/repo.CS3?x=1#y", Type: "NUVIO_JS"}:    false,
		{URL: "https://a/manifest.json?file=x.cs3"}:            true,
	} {
		if got := r.Runnable(); got != want {
			t.Errorf("%+v Runnable = %v, want %v", r, got, want)
		}
	}
}

// A pulled list replaces the repositories without queuing a push, drops the
// plugins of a repository that is gone, and keeps the rest (#57).
func TestApplyPluginRepos(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "Linked", NuvioIndex: ptr(1)}))
	id := p.ID
	check(t, s.InstallPluginRepo(id, repoA, PluginCache{Plugins: []PluginEntry{alpha}}))
	check(t, s.InstallPluginRepo(id, repoB, PluginCache{Plugins: []PluginEntry{beta}}))
	check(t, s.EnablePlugin(id, "beta", true))
	// What was queued has gone to the server.
	for _, push := range must[[]Push](t)(s.Pending(id)) {
		check(t, s.AckPush(id, push))
	}

	item, err := json.Marshal([]PluginRepo{repoB, {URL: "https://c.example/manifest.json", Enabled: true}})
	check(t, err)
	applied := must[int](t)(s.ApplyChanges(id, []Change{{Surface: SurfacePlugins, Op: OpUpsert, Item: item}}))
	if applied != 1 {
		t.Fatalf("applied %d changes, want 1", applied)
	}
	equal(t, must[[]PluginRepo](t)(s.PluginRepos(id)), []PluginRepo{repoB, {URL: "https://c.example/manifest.json", Enabled: true}})
	caches := must[PluginConfig](t)(s.PluginConfig(id)).Caches
	if _, ok := caches[repoA.URL]; ok || len(caches[repoB.URL].Plugins) != 1 || !caches[repoB.URL].Plugins[0].Enabled {
		t.Fatalf("caches after the pull = %+v", caches)
	}
	if n := len(must[[]Push](t)(s.Pending(id))); n != 0 {
		t.Fatalf("a pull queued %d pushes", n)
	}

	// The echo of the same list changes nothing.
	if applied := must[int](t)(s.ApplyChanges(id, []Change{{Surface: SurfacePlugins, Op: OpUpsert, Item: item}})); applied != 0 {
		t.Fatalf("applying the same list again changed %d", applied)
	}

	// A list edited here and not yet pushed isn't overwritten by the pull.
	check(t, s.EnablePluginRepo(id, repoB.URL, false))
	old, _ := json.Marshal([]PluginRepo{repoB})
	if applied := must[int](t)(s.ApplyChanges(id, []Change{{Surface: SurfacePlugins, Op: OpUpsert, Item: old}})); applied != 0 {
		t.Fatalf("a pull over a queued push applied %d", applied)
	}
}
