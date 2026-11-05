package backend

import (
	"context"
	"encoding/json"
	"fmt"

	"github.com/k22i/Sinag/internal/nuvio"
	"github.com/k22i/Sinag/internal/store"
)

// Plugin repository sync (#57, ADR-0047). Nuvio's plugins table holds
// repositories, not the plugins in them: manifest URL, name, an enabled flag,
// a type and an order. It is replaced whole on push like the addon list, so
// it syncs the same way (addons.go): the pull reads the whole list, and a
// push is three-way merged with the server's list first. What the table
// can't hold stays on this device: the master switch, each plugin's on/off
// and its settings.

// pluginsIndex is the Nuvio profile whose repository list profile reads and
// writes: the primary's if it uses the primary's plugins, else its own.
func pluginsIndex(profile store.Profile, index int) int {
	if profile.UsesPrimaryPlugins {
		return primaryIndex
	}
	return index
}

func (n Nuvio) pullPlugins(ctx context.Context, s nuvio.Session, index int) (Change, error) {
	rows, err := n.Client.Plugins(ctx, s, index)
	if err != nil {
		return Change{}, err
	}
	return newChange(store.SurfacePlugins, store.OpUpsert, fromPluginRows(rows))
}

// pushPlugins sends the newest of pushes, merged with the server's list if it
// has a base to merge from. Every push in the batch is acked with it: each
// newer one includes the older ones' edits.
func (n Nuvio) pushPlugins(ctx context.Context, s nuvio.Session, index int, pushes []store.Push) error {
	newest := pushes[len(pushes)-1]
	var list []store.PluginRepo
	if err := json.Unmarshal(newest.Item, &list); err != nil {
		return fmt.Errorf("backend: plugins push: %w", err)
	}
	if newest.Base != nil {
		var base []store.PluginRepo
		if err := json.Unmarshal(newest.Base, &base); err != nil {
			return fmt.Errorf("backend: plugins push base: %w", err)
		}
		rows, err := n.Client.Plugins(ctx, s, index)
		if err != nil {
			return err
		}
		list = mergePluginRepos(base, list, fromPluginRows(rows))
	}
	rows := make([]nuvio.PluginRow, len(list))
	for i, r := range list {
		rows[i] = nuvio.PluginRow{URL: r.URL, Name: text(r.Name), Enabled: r.Enabled, RepoType: text(r.Type)}
	}
	return n.Client.PushPlugins(ctx, s, index, rows)
}

// text is a column's value: nil for "", since the columns are nullable and
// Nuvio's own clients leave a type out.
func text(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

func fromPluginRows(rows []nuvio.PluginRow) []store.PluginRepo {
	repos := make([]store.PluginRepo, len(rows))
	for i, r := range rows {
		repos[i] = store.PluginRepo{URL: r.URL, Enabled: r.Enabled}
		if r.Name != nil {
			repos[i].Name = *r.Name
		}
		if r.RepoType != nil {
			repos[i].Type = *r.RepoType
		}
	}
	return repos
}

// mergePluginRepos is mergeAddons for repositories, matched by manifest URL.
// Repositories Sinag can't run (Cloudstream's) are in both lists and are
// carried through like any other, so a push doesn't delete them.
func mergePluginRepos(base, local, server []store.PluginRepo) []store.PluginRepo {
	return mergeByURL(base, local, server, func(r store.PluginRepo) string { return r.URL })
}
