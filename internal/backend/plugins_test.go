package backend

import (
	"strings"
	"testing"

	"github.com/k22i/Sinag/internal/nuvio/nuviotest"
	"github.com/k22i/Sinag/internal/store"
)

// repos builds a list from names: "a" is repository a, "A" is a turned off,
// and "a!" is a Cloudstream (EXTERNAL_DEX) repository Sinag can't run.
func repos(names string) []store.PluginRepo {
	list := []store.PluginRepo{}
	for _, n := range strings.Split(names, " ") {
		if n == "" {
			continue
		}
		dex := strings.HasSuffix(n, "!")
		n = strings.TrimSuffix(n, "!")
		lower := strings.ToLower(n)
		r := store.PluginRepo{URL: "https://" + lower + "/manifest.json", Name: lower, Enabled: n == lower, Type: store.PluginTypeJS}
		if dex {
			r.Type = "EXTERNAL_DEX"
		}
		list = append(list, r)
	}
	return list
}

func repoNames(list []store.PluginRepo) string {
	var out []string
	for _, r := range list {
		n := r.Name
		if !r.Enabled {
			n = strings.ToUpper(n)
		}
		if r.Type == "EXTERNAL_DEX" {
			n += "!"
		}
		out = append(out, n)
	}
	return strings.Join(out, " ")
}

// The same rules as the addon list (TestMergeAddons): they share mergeByURL.
func TestMergePluginRepos(t *testing.T) {
	for _, c := range []struct {
		name                       string
		base, local, server, merge string
	}{
		{"nothing changed elsewhere", "a b", "b c", "a b", "b c"},
		{"nothing changed here", "a b", "a b", "a b c", "a b c"},
		{"added on both", "a", "a b", "a c", "a c b"},
		{"removed here", "a b c", "a c", "a b c d", "a c d"},
		{"removed elsewhere, kept here", "a b", "a b", "a", "a"},
		{"turned off here", "a b", "A b", "a b c", "A b c"},
		{"reordered here", "a b c", "c a b", "a b c d", "c a b d"},
		{"never pulled", "", "x", "a b", "a b x"},
		// What this device can't run is another device's, and survives.
		{"a Cloudstream repository on the server stays", "a", "a b", "a c!", "a c! b"},
		{"a Cloudstream repository stays through a removal", "a b", "b", "a b c!", "b c!"},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := repoNames(mergePluginRepos(repos(c.base), repos(c.local), repos(c.server)))
			if got != c.merge {
				t.Fatalf("merge(base %q, local %q, server %q) = %q, want %q", c.base, c.local, c.server, got, c.merge)
			}
		})
	}
}

// A repository installed on the desktop reaches the phone, and the desktop's
// out-of-date list doesn't undo the phone's change, as with addons (#57).
func TestPluginReposSyncBetweenDevices(t *testing.T) {
	server := nuviotest.NewServer(t)
	phone, desktop := newDevice(t, server), newDevice(t, server)
	a, b, c := repos("a")[0], repos("b")[0], repos("c")[0]
	cache := store.PluginCache{Plugins: []store.PluginEntry{{ID: "p", Name: "P", File: "https://a/p.js", Enabled: true}}}

	check(t, desktop.store.InstallPluginRepo(desktop.profile.ID, a, cache))
	desktop.push(t)
	phone.pull(t)
	if got, _ := phone.store.PluginRepos(phone.profile.ID); repoNames(got) != "a" {
		t.Fatalf("phone has %q", repoNames(got))
	}
	// The master switch and the plugins of a repository are local: the phone
	// has the repository, not its plugins, and plugins stay off there.
	if config, _ := phone.store.PluginConfig(phone.profile.ID); config.Enabled || len(config.Caches) != 0 {
		t.Fatalf("phone's config = %+v, want off and empty", config)
	}

	check(t, phone.store.InstallPluginRepo(phone.profile.ID, b, cache))
	phone.push(t)
	check(t, desktop.store.InstallPluginRepo(desktop.profile.ID, c, cache))
	desktop.push(t)
	if rows := server.SyncedPlugins(email, 1); len(rows) != 3 {
		t.Fatalf("server has %v, want a, b and c", rows)
	}
	for _, d := range []*device{phone, desktop} {
		d.pull(t)
		if got, _ := d.store.PluginRepos(d.profile.ID); repoNames(got) != "a b c" {
			t.Fatalf("after pulling, a device has %q", repoNames(got))
		}
	}

	// Removing on the desktop goes everywhere, and takes the plugins with it.
	check(t, desktop.store.RemovePluginRepo(desktop.profile.ID, a.URL))
	desktop.push(t)
	phone.pull(t)
	if got, _ := phone.store.PluginRepos(phone.profile.ID); repoNames(got) != "b c" {
		t.Fatalf("phone has %q", repoNames(got))
	}
	if config, _ := phone.store.PluginConfig(phone.profile.ID); len(config.Caches) != 1 {
		t.Fatalf("phone kept plugins of %v", config.Caches)
	}
}

// What Nuvio's own apps put in the table survives a push from Sinag: a
// Cloudstream repository, one without a type, and a row's name.
func TestPluginPushKeepsOtherClientsRows(t *testing.T) {
	server := nuviotest.NewServer(t)
	desktop := newDevice(t, server)
	// Another client's list, pushed the way Nuvio's apps do.
	other := newDevice(t, server)
	check(t, other.store.InstallPluginRepo(other.profile.ID, repos("x!")[0], store.PluginCache{}))
	check(t, other.store.InstallPluginRepo(other.profile.ID, store.PluginRepo{URL: "https://old.example/manifest.json", Enabled: true}, store.PluginCache{}))
	other.push(t)

	desktop.pull(t)
	check(t, desktop.store.InstallPluginRepo(desktop.profile.ID, repos("a")[0], store.PluginCache{}))
	desktop.push(t)
	rows := server.SyncedPlugins(email, 1)
	if len(rows) != 3 {
		t.Fatalf("server has %v, want the two others and a", rows)
	}
	if rows[0]["repo_type"] != "EXTERNAL_DEX" || rows[1]["repo_type"] != nil || rows[2]["repo_type"] != store.PluginTypeJS {
		t.Fatalf("types on the server: %v", rows)
	}
	if rows[2]["sort_order"] != 2 && rows[2]["sort_order"] != 2.0 {
		t.Fatalf("a's sort_order = %v", rows[2]["sort_order"])
	}
}

// A profile that uses the primary profile's plugins reads and writes profile
// 1's list; the server has none of its own for it.
func TestSharedPluginsArePrimarys(t *testing.T) {
	server := nuviotest.NewServer(t)
	primary := newDevice(t, server)
	check(t, primary.store.InstallPluginRepo(primary.profile.ID, repos("a")[0], store.PluginCache{}))
	primary.push(t)

	kids := newDevice(t, server)
	kids.profile.NuvioIndex = ptr(3)
	kids.profile.UsesPrimaryPlugins = true
	kids.pull(t)
	if got, _ := kids.store.PluginRepos(kids.profile.ID); repoNames(got) != "a" {
		t.Fatalf("profile 3 has %q, want the primary's", repoNames(got))
	}
	check(t, kids.store.InstallPluginRepo(kids.profile.ID, repos("b")[0], store.PluginCache{}))
	kids.push(t)
	if rows := server.SyncedPlugins(email, 1); len(rows) != 2 {
		t.Fatalf("primary has %v on the server", rows)
	}
	if rows := server.SyncedPlugins(email, 3); len(rows) != 0 {
		t.Fatalf("profile 3 has %v of its own", rows)
	}

	// Sharing addons but not plugins: its own list.
	kids.profile.UsesPrimaryPlugins = false
	kids.profile.UsesPrimaryAddons = true
	changes, _, err := kids.backend.Pull(t.Context(), kids.profile, store.SurfacePlugins, 0, true)
	check(t, err)
	if len(changes) != 1 || string(changes[0].Item) != "[]" {
		t.Fatalf("profile 3 pulled %+v, want its own empty list", changes)
	}
}
