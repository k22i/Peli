package store

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"maps"
	"slices"
	"strings"

	bolt "go.etcd.io/bbolt"
)

// Plugins (#57, ADR-0047) are two records in a profile's bucket.
//
// The repository list ("plugin-repos") is what Nuvio's plugins table holds:
// manifest URL, name, an enabled flag and a type, in order. It syncs the way
// the addon list does (ADR-0019): saved whole, pushed whole, merged with
// what other devices changed since.
//
// Everything else is local, because Nuvio has nowhere to put it ("plugin-
// config"): the master switch, which is off until the user turns it on, and
// for each repository the plugins its manifest listed when it was last read,
// with each plugin's on/off and its settings.

// PluginTypeJS is the repo_type of a repository of Nuvio JS plugins, the kind
// Sinag runs. Android's Cloudstream repositories ("EXTERNAL_DEX") share the
// table but can't run here; they stay in the list, or the next push would
// delete them from the phone.
const PluginTypeJS = "NUVIO_JS"

// PluginRepo is an installed plugin repository, by its manifest URL.
type PluginRepo struct {
	URL     string `json:"url"`
	Name    string `json:"name,omitempty"`
	Enabled bool   `json:"enabled"`
	// Nuvio's repo_type, or "" where the client that added it sent none.
	Type string `json:"type,omitempty"`
}

// Runnable is whether Sinag can run the repository's plugins: JS plugins, or
// a repository of unknown type with a manifest URL (older Nuvio clients send
// no type), but not Cloudstream's .cs3 files or URL templates.
func (r PluginRepo) Runnable() bool {
	switch strings.ToUpper(strings.ReplaceAll(strings.ReplaceAll(strings.TrimSpace(r.Type), "-", "_"), " ", "_")) {
	case "", PluginTypeJS, "JS":
		path, _, _ := strings.Cut(strings.SplitN(r.URL, "#", 2)[0], "?")
		return !strings.HasSuffix(strings.ToLower(path), ".cs3")
	}
	return false
}

// PluginEntry is one plugin as its repository's manifest listed it, with this
// profile's choices about it.
type PluginEntry struct {
	ID             string   `json:"id"`
	Name           string   `json:"name"`
	Description    string   `json:"description,omitempty"`
	Version        string   `json:"version,omitempty"`
	Author         string   `json:"author,omitempty"`
	SupportedTypes []string `json:"supportedTypes"`
	// File is the URL of its code.
	File string `json:"file"`
	// Enabled starts as the manifest says (Nuvio does the same) and is the
	// user's from then on: a refresh keeps it.
	Enabled bool `json:"enabled"`
	// Settings are its SCRAPER_SETTINGS. A refresh keeps them.
	Settings map[string]any `json:"settings,omitempty"`
}

// PluginCache is what a repository's manifest said when it was last read.
type PluginCache struct {
	Name    string `json:"name,omitempty"`
	Version string `json:"version,omitempty"`
	// FetchedAt is when it was read, in ms since the epoch.
	FetchedAt int64         `json:"fetchedAt"`
	Plugins   []PluginEntry `json:"plugins"`
}

// PluginConfig is a profile's local plugin state.
type PluginConfig struct {
	// Enabled is the master switch. Off, no plugin is asked for anything.
	// It is per profile, like the repositories, but only this device
	// knows it: Nuvio has no such field, and each person decides for
	// themselves whether to run third-party scrapers.
	Enabled bool `json:"enabled"`
	// Caches is each repository's plugins, by manifest URL.
	Caches map[string]PluginCache `json:"caches"`
}

var (
	// ErrPluginRepoInstalled means the manifest URL is already in the
	// profile's list.
	ErrPluginRepoInstalled = errors.New("store: plugin repository is already installed")
	// ErrPluginRepoNotFound means the profile has no repository at that
	// manifest URL.
	ErrPluginRepoNotFound = errors.New("store: plugin repository not found")
	// ErrPluginNotFound means none of the profile's repositories lists the
	// plugin.
	ErrPluginNotFound = errors.New("store: plugin not found")
)

// PluginRepos returns profile id's plugin repositories in order.
func (s *Store) PluginRepos(id uint64) ([]PluginRepo, error) {
	repos := []PluginRepo{}
	err := s.view(id, func(p *bolt.Bucket) error {
		if data := p.Get(keyPluginRepos); data != nil {
			return json.Unmarshal(data, &repos)
		}
		return nil
	})
	return repos, err
}

// PluginConfig returns profile id's plugin switch and the plugins of its
// repositories: off, with none, until set.
func (s *Store) PluginConfig(id uint64) (PluginConfig, error) {
	var config PluginConfig
	err := s.view(id, func(p *bolt.Bucket) error {
		var err error
		config, err = readPluginConfig(p)
		return err
	})
	return config, err
}

func readPluginConfig(p *bolt.Bucket) (PluginConfig, error) {
	config := PluginConfig{Caches: map[string]PluginCache{}}
	if err := decodeOnto(p.Get(keyPluginConfig), &config); err != nil {
		return PluginConfig{}, err
	}
	if config.Caches == nil {
		config.Caches = map[string]PluginCache{}
	}
	return config, nil
}

func (s *Store) editPluginConfig(id uint64, edit func(*PluginConfig) error) error {
	return s.update(id, func(p *bolt.Bucket) error { return editPluginConfigIn(p, edit) })
}

func editPluginConfigIn(p *bolt.Bucket, edit func(*PluginConfig) error) error {
	config, err := readPluginConfig(p)
	if err != nil {
		return err
	}
	if err := edit(&config); err != nil {
		return err
	}
	return put(p, keyPluginConfig, config)
}

// SetPluginsEnabled turns the master switch on or off.
func (s *Store) SetPluginsEnabled(id uint64, enabled bool) error {
	return s.editPluginConfig(id, func(c *PluginConfig) error {
		c.Enabled = enabled
		return nil
	})
}

// InstallPluginRepo adds repo at the end of profile id's list, with the
// plugins its manifest listed.
func (s *Store) InstallPluginRepo(id uint64, repo PluginRepo, cache PluginCache) error {
	return s.update(id, func(p *bolt.Bucket) error {
		err := editPluginRepoList(p, func(repos []PluginRepo) ([]PluginRepo, error) {
			if indexOfPluginRepo(repos, repo.URL) >= 0 {
				return nil, fmt.Errorf("%w: %s", ErrPluginRepoInstalled, repo.URL)
			}
			return append(repos, repo), nil
		})
		if err != nil {
			return err
		}
		return editPluginConfigIn(p, func(c *PluginConfig) error {
			c.Caches[repo.URL] = cache
			return nil
		})
	})
}

// RemovePluginRepo removes the repository at manifest URL url, and its
// plugins, from profile id.
func (s *Store) RemovePluginRepo(id uint64, url string) error {
	return s.update(id, func(p *bolt.Bucket) error {
		err := editPluginRepoList(p, func(repos []PluginRepo) ([]PluginRepo, error) {
			i := indexOfPluginRepo(repos, url)
			if i < 0 {
				return nil, fmt.Errorf("%w: %s", ErrPluginRepoNotFound, url)
			}
			return slices.Delete(repos, i, i+1), nil
		})
		if err != nil {
			return err
		}
		return editPluginConfigIn(p, func(c *PluginConfig) error {
			delete(c.Caches, url)
			return nil
		})
	})
}

// EnablePluginRepo turns the repository at manifest URL url on or off. Off,
// none of its plugins is asked.
func (s *Store) EnablePluginRepo(id uint64, url string, enabled bool) error {
	return s.update(id, func(p *bolt.Bucket) error {
		return editPluginRepoList(p, func(repos []PluginRepo) ([]PluginRepo, error) {
			i := indexOfPluginRepo(repos, url)
			if i < 0 {
				return nil, fmt.Errorf("%w: %s", ErrPluginRepoNotFound, url)
			}
			repos[i].Enabled = enabled
			return repos, nil
		})
	})
}

// SetPluginCache keeps cache as what the manifest of the repository at url
// says now. A plugin that was there before keeps its on/off and settings; a
// new one starts as the manifest has it. Nothing is queued: the list Nuvio
// has doesn't change.
func (s *Store) SetPluginCache(id uint64, url string, cache PluginCache) error {
	return s.update(id, func(p *bolt.Bucket) error {
		repos, err := pluginReposIn(p)
		if err != nil {
			return err
		}
		if indexOfPluginRepo(repos, url) < 0 {
			return fmt.Errorf("%w: %s", ErrPluginRepoNotFound, url)
		}
		return editPluginConfigIn(p, func(c *PluginConfig) error {
			before := map[string]PluginEntry{}
			for _, e := range c.Caches[url].Plugins {
				before[e.ID] = e
			}
			cache.Plugins = slices.Clone(cache.Plugins)
			for i, e := range cache.Plugins {
				if old, ok := before[e.ID]; ok {
					cache.Plugins[i].Enabled, cache.Plugins[i].Settings = old.Enabled, old.Settings
				}
			}
			c.Caches[url] = cache
			return nil
		})
	})
}

// EnablePlugin turns the plugin with id pluginID on or off.
func (s *Store) EnablePlugin(id uint64, pluginID string, enabled bool) error {
	return s.editPlugin(id, pluginID, func(e *PluginEntry) { e.Enabled = enabled })
}

// SetPluginSettings keeps settings as the plugin's SCRAPER_SETTINGS; nil
// clears them.
func (s *Store) SetPluginSettings(id uint64, pluginID string, settings map[string]any) error {
	return s.editPlugin(id, pluginID, func(e *PluginEntry) { e.Settings = maps.Clone(settings) })
}

// editPlugin changes the plugin in every repository that lists it: plugin ids
// are taken to be unique, as Nuvio takes them.
func (s *Store) editPlugin(id uint64, pluginID string, edit func(*PluginEntry)) error {
	return s.editPluginConfig(id, func(c *PluginConfig) error {
		found := false
		for url, cache := range c.Caches {
			for i := range cache.Plugins {
				if cache.Plugins[i].ID == pluginID {
					edit(&cache.Plugins[i])
					found = true
				}
			}
			c.Caches[url] = cache
		}
		if !found {
			return fmt.Errorf("%w: %s", ErrPluginNotFound, pluginID)
		}
		return nil
	})
}

func indexOfPluginRepo(repos []PluginRepo, url string) int {
	return slices.IndexFunc(repos, func(r PluginRepo) bool { return r.URL == url })
}

func pluginReposIn(p *bolt.Bucket) ([]PluginRepo, error) {
	repos := []PluginRepo{}
	if data := p.Get(keyPluginRepos); data != nil {
		if err := json.Unmarshal(data, &repos); err != nil {
			return nil, err
		}
	}
	return repos, nil
}

// editPluginRepoList changes the repository list on profile bucket p with
// edit and queues the whole new list for push, with the list the backend
// last had as its base, as editAddonList does (ADR-0019). An edit that
// changes nothing queues nothing.
func editPluginRepoList(p *bolt.Bucket, edit func([]PluginRepo) ([]PluginRepo, error)) error {
	before := p.Get(keyPluginRepos)
	repos := []PluginRepo{}
	if before != nil {
		if err := json.Unmarshal(before, &repos); err != nil {
			return err
		}
	} else {
		before = []byte("[]")
	}
	repos, err := edit(repos)
	if err != nil {
		return err
	}
	if repos == nil {
		repos = []PluginRepo{}
	}
	if err := validatePluginRepos(repos); err != nil {
		return err
	}
	data, err := json.Marshal(repos)
	if err != nil {
		return err
	}
	if bytes.Equal(data, before) {
		return nil
	}
	if err := p.Put(keyPluginRepos, data); err != nil {
		return err
	}
	base := json.RawMessage(bytes.Clone(before))
	if queued := p.Bucket(bucketOutbox).Get(joinKey(string(SurfacePlugins), "")); queued != nil {
		var push Push
		if err := json.Unmarshal(queued, &push); err != nil {
			return err
		}
		base = push.Base
	}
	return queue(p, Push{Surface: SurfacePlugins, Op: OpUpsert, Item: data, Base: base})
}

func validatePluginRepos(repos []PluginRepo) error {
	seen := map[string]bool{}
	for _, r := range repos {
		if r.URL == "" {
			return fmt.Errorf("%w: plugin repository needs a URL", ErrInvalidItem)
		}
		if seen[r.URL] {
			return fmt.Errorf("%w: plugin repository %s is listed twice", ErrInvalidItem, r.URL)
		}
		seen[r.URL] = true
	}
	return nil
}

// prunePluginCaches drops the plugins of repositories that are no longer in
// the list: one removed on another device.
func prunePluginCaches(p *bolt.Bucket, repos []PluginRepo) error {
	if p.Get(keyPluginConfig) == nil {
		return nil
	}
	return editPluginConfigIn(p, func(c *PluginConfig) error {
		for url := range c.Caches {
			if indexOfPluginRepo(repos, url) < 0 {
				delete(c.Caches, url)
			}
		}
		return nil
	})
}
