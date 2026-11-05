package backend

import (
	"context"
	"encoding/json"
	"fmt"
	"slices"

	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/store"
)

// Addon list sync (#32, ADR-0019). Nuvio has no addons feed and replaces the
// whole list on push, so a push from a list that is out of date would undo
// what another device changed since. The push is therefore merged first:
// what this device changed (its base to its list) is applied to the list the
// server has now.

// primaryIndex is the Nuvio profile whose addons a profile with
// uses_primary_addons shares.
const primaryIndex = 1

// addonsIndex is the Nuvio profile whose addon list profile reads and
// writes: the primary's if it shares them, else its own. The server doesn't
// redirect: a sharing profile has no addon rows of its own.
func addonsIndex(profile store.Profile, index int) int {
	if profile.UsesPrimaryAddons {
		return primaryIndex
	}
	return index
}

func (n Nuvio) pullAddons(ctx context.Context, s nuvio.Session, index int) (Change, error) {
	rows, err := n.Client.Addons(ctx, s, index)
	if err != nil {
		return Change{}, err
	}
	return newChange(store.SurfaceAddons, store.OpUpsert, fromAddonRows(rows))
}

// pushAddons sends the newest of pushes, merged with the server's list if it
// has a base to merge from. Every push in the batch is acked with it: each
// newer one includes the older ones' edits.
func (n Nuvio) pushAddons(ctx context.Context, s nuvio.Session, index int, pushes []store.Push) error {
	newest := pushes[len(pushes)-1]
	var list []store.Addon
	if err := json.Unmarshal(newest.Item, &list); err != nil {
		return fmt.Errorf("backend: addons push: %w", err)
	}
	// Built-in addons stay on this device (#107).
	list = store.SyncedAddons(list)
	if newest.Base != nil {
		var base []store.Addon
		if err := json.Unmarshal(newest.Base, &base); err != nil {
			return fmt.Errorf("backend: addons push base: %w", err)
		}
		base = store.SyncedAddons(base)
		rows, err := n.Client.Addons(ctx, s, index)
		if err != nil {
			return err
		}
		list = mergeAddons(base, list, fromAddonRows(rows))
	}
	rows := make([]nuvio.AddonRow, len(list))
	for i, a := range list {
		rows[i] = nuvio.AddonRow{URL: a.URL, Name: a.Name, Enabled: a.Enabled}
	}
	return n.Client.PushAddons(ctx, s, index, rows)
}

func fromAddonRows(rows []nuvio.AddonRow) []store.Addon {
	addons := make([]store.Addon, len(rows))
	for i, r := range rows {
		addons[i] = store.Addon{URL: r.URL, Name: r.Name, Enabled: r.Enabled}
	}
	return addons
}

// mergeAddons applies what changed from base to local onto server, the list
// the backend has now, and returns the list to push. Addons are matched by
// manifest URL; see mergeByURL for the rules.
func mergeAddons(base, local, server []store.Addon) []store.Addon {
	return mergeByURL(base, local, server, func(a store.Addon) string { return a.URL })
}

// mergeByURL is the three-way merge both lists that Nuvio replaces whole
// share, addons and plugin repositories (#57). Items are matched by URL.
//
//   - Removed here: removed, unless it is gone already.
//   - Added here: added, or updated if another device added it too. It goes
//     before the item after it here, or last, as an install does.
//   - Turned on or off, or renamed, here: so on the server too, unless
//     another device removed it, which wins.
//   - Reordered here: local's order, with what only the server has after it.
//     Otherwise the server's order stands, so a reorder on another device
//     isn't undone.
//
// Edits on other devices that this device didn't touch are kept. With
// nothing changed elsewhere (server equals base) the result is local.
func mergeByURL[T comparable](base, local, server []T, url func(T) string) []T {
	inBase := map[string]T{}
	for _, a := range base {
		inBase[url(a)] = a
	}
	inLocal := map[string]bool{}
	for _, a := range local {
		inLocal[url(a)] = true
	}

	merged := []T{}
	for _, a := range server {
		if _, ok := inBase[url(a)]; ok && !inLocal[url(a)] {
			continue // removed here
		}
		merged = append(merged, a)
	}
	for i, a := range local {
		at := indexByURL(merged, url(a), url)
		was, known := inBase[url(a)]
		switch {
		case at >= 0 && (!known || was != a):
			merged[at] = a // edited here, or added on both
		case at < 0 && !known:
			// Added here: before the item after it here, or last.
			pos := len(merged)
			for _, next := range local[i+1:] {
				if k := indexByURL(merged, url(next), url); k >= 0 {
					pos = k
					break
				}
			}
			merged = slices.Insert(merged, pos, a)
		}
		// at < 0 && known: removed on another device, which wins.
	}

	if !reordered(base, local, url) {
		return merged
	}
	ordered := make([]T, 0, len(merged))
	for _, a := range local {
		if k := indexByURL(merged, url(a), url); k >= 0 {
			ordered = append(ordered, merged[k])
		}
	}
	for _, a := range merged {
		if !inLocal[url(a)] {
			ordered = append(ordered, a)
		}
	}
	return ordered
}

// reordered is whether the items in both base and local are in a different
// order in local.
func reordered[T any](base, local []T, url func(T) string) bool {
	inLocal := map[string]bool{}
	for _, a := range local {
		inLocal[url(a)] = true
	}
	var before []string
	for _, a := range base {
		if inLocal[url(a)] {
			before = append(before, url(a))
		}
	}
	i := 0
	for _, a := range local {
		if i < len(before) && url(a) == before[i] {
			i++
		} else if slices.Contains(before, url(a)) {
			return true
		}
	}
	return false
}

func indexByURL[T any](list []T, link string, url func(T) string) int {
	return slices.IndexFunc(list, func(a T) bool { return url(a) == link })
}
