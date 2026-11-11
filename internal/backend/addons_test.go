package backend

import (
	"strings"
	"testing"

	"github.com/k22i/Peli/internal/nuvio/nuviotest"
	"github.com/k22i/Peli/internal/store"
)

// addons builds a list from names: "a" is addon a, "A" is addon a turned off.
func addons(names string) []store.Addon {
	list := []store.Addon{}
	for _, n := range strings.Split(names, " ") {
		if n == "" {
			continue
		}
		lower := strings.ToLower(n)
		list = append(list, store.Addon{URL: "https://" + lower + "/manifest.json", Name: lower, Enabled: n == lower})
	}
	return list
}

func names(list []store.Addon) string {
	var out []string
	for _, a := range list {
		n := a.Name
		if !a.Enabled {
			n = strings.ToUpper(n)
		}
		out = append(out, n)
	}
	return strings.Join(out, " ")
}

func TestMergeAddons(t *testing.T) {
	for _, c := range []struct {
		name                       string
		base, local, server, merge string
	}{
		{"nothing changed elsewhere", "a b", "b c", "a b", "b c"},
		{"nothing changed here", "a b", "a b", "a b c", "a b c"},
		{"added on both", "a", "a b", "a c", "a c b"},
		{"added here before its neighbour", "a b c", "a b x c", "a c b", "a x c b"},
		{"added here first", "a", "x a", "a b", "x a b"},
		{"added on both, the same", "a", "a b", "a B", "a b"},
		{"removed here", "a b c", "a c", "a b c d", "a c d"},
		{"removed on both", "a b", "a", "a", "a"},
		{"removed elsewhere, kept here", "a b", "a b", "a", "a"},
		{"removed elsewhere, turned off here", "a b", "a B", "a", "a"},
		{"turned off here", "a b", "A b", "a b c", "A b c"},
		{"turned off elsewhere", "a b", "a b x", "A b", "A b x"},
		{"reordered here", "a b c", "c a b", "a b c d", "c a b d"},
		{"reordered elsewhere", "a b c", "a b c x", "c b a", "c b a x"},
		{"reordered on both: ours", "a b c", "b a c", "c b a", "b a c"},
		{"emptied here", "a b", "", "a b c", "c"},
		{"never pulled", "", "x", "a b", "a b x"},
	} {
		t.Run(c.name, func(t *testing.T) {
			got := names(mergeAddons(addons(c.base), addons(c.local), addons(c.server)))
			if got != c.merge {
				t.Fatalf("merge(base %q, local %q, server %q) = %q, want %q", c.base, c.local, c.server, got, c.merge)
			}
		})
	}
}

// The ticket's acceptance criterion against the fake: an addon installed on
// the desktop is on the server for the phone, and the other way round, and a
// desktop whose list is out of date doesn't undo the phone's change (#32).
func TestAddonsSyncBetweenDevices(t *testing.T) {
	server := nuviotest.NewServer(t)
	phone, desktop := newDevice(t, server), newDevice(t, server)
	a, b, c := addons("a")[0], addons("b")[0], addons("c")[0]

	check(t, desktop.store.InstallAddon(desktop.profile.ID, a))
	desktop.push(t)
	phone.pull(t)
	if got, _ := phone.store.Addons(phone.profile.ID); names(got) != "a" {
		t.Fatalf("phone has %q", names(got))
	}

	// The phone installs b; the desktop hasn't pulled since and installs c.
	check(t, phone.store.InstallAddon(phone.profile.ID, b))
	phone.push(t)
	check(t, desktop.store.InstallAddon(desktop.profile.ID, c))
	desktop.push(t)
	if rows := server.SyncedAddons(email, 1); len(rows) != 3 {
		t.Fatalf("server has %v, want a, b and c", rows)
	}
	for _, d := range []*device{phone, desktop} {
		d.pull(t)
		if got, _ := d.store.Addons(d.profile.ID); names(got) != "a b c" {
			t.Fatalf("after pulling, a device has %q", names(got))
		}
	}

	// Removing on the desktop goes everywhere.
	check(t, desktop.store.RemoveAddon(desktop.profile.ID, a.URL))
	desktop.push(t)
	phone.pull(t)
	if got, _ := phone.store.Addons(phone.profile.ID); names(got) != "b c" {
		t.Fatalf("phone has %q", names(got))
	}
}

// A profile that uses the primary profile's addons reads and writes profile
// 1's list; the server has none of its own for it.
func TestSharedAddonsArePrimarys(t *testing.T) {
	server := nuviotest.NewServer(t)
	primary := newDevice(t, server)
	check(t, primary.store.InstallAddon(primary.profile.ID, addons("a")[0]))
	primary.push(t)

	kids := newDevice(t, server)
	kids.profile.NuvioIndex = ptr(3)
	kids.profile.UsesPrimaryAddons = true
	kids.pull(t)
	if got, _ := kids.store.Addons(kids.profile.ID); names(got) != "a" {
		t.Fatalf("kids profile has %q, want the primary's", names(got))
	}
	check(t, kids.store.InstallAddon(kids.profile.ID, addons("b")[0]))
	kids.push(t)
	if rows := server.SyncedAddons(email, 1); len(rows) != 2 {
		t.Fatalf("primary has %v on the server", rows)
	}
	if rows := server.SyncedAddons(email, 3); len(rows) != 0 {
		t.Fatalf("profile 3 has %v of its own", rows)
	}

	// Not sharing: its own list.
	kids.profile.UsesPrimaryAddons = false
	changes, _, err := kids.backend.Pull(t.Context(), kids.profile, store.SurfaceAddons, 0, true)
	check(t, err)
	if len(changes) != 1 || string(changes[0].Item) != "[]" {
		t.Fatalf("profile 3 pulled %+v, want its own empty list", changes)
	}
}

// Built-in addons stay on the device that has them (#107): pushes leave them
// out, pulls keep them in place, and editing only them pushes nothing.
func TestBuiltinAddonsStayOnTheDevice(t *testing.T) {
	server := nuviotest.NewServer(t)
	phone, desktop := newDevice(t, server), newDevice(t, server)
	check(t, desktop.store.UseBuiltins(store.Builtins))
	a := addons("a")[0]

	check(t, desktop.store.InstallAddon(desktop.profile.ID, a))
	desktop.push(t)
	if rows := server.SyncedAddons(email, 1); len(rows) != 1 {
		t.Fatalf("server has %v, want only a", rows)
	}
	phone.pull(t)
	if got, _ := phone.store.Addons(phone.profile.ID); names(got) != "a" {
		t.Fatalf("phone has %q", names(got))
	}
	desktop.pull(t)
	if got, _ := desktop.store.Addons(desktop.profile.ID); names(got) != "AniList a" {
		t.Fatalf("desktop has %q after pulling", names(got))
	}

	check(t, desktop.store.EnableAddon(desktop.profile.ID, store.AniListAddon.URL, false))
	if pending, _ := desktop.store.Pending(desktop.profile.ID); len(pending) != 0 {
		t.Fatalf("turning a built-in addon off queued %v", pending)
	}
}
