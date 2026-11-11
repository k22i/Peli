package plugins

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/k22i/Peli/internal/store"
)

// Plugin management (#57, ADR-0047): which plugins a profile runs.
//
// Plugins are off until the profile's master switch is turned on, a kids
// profile never has them, and Installed (what the picker asks) is built from
// the profile's stored repositories and plugins and from nothing else. The
// repository list syncs with Nuvio (internal/backend/plugins.go); the
// switch, each plugin's on/off and its settings stay on this device.

// Editor runs edit on the store if the profile may be changed: unlocked, and
// with the parent PIN approved if it, or the profile in use, is a kids
// profile. account.EditorOf gives the app's.
type Editor func(profileID uint64, edit func(db *store.Store) error) error

// UseStore gives s the store its plugins are kept in, and the editor that
// guards changes to it. It isn't a method, so Wails doesn't bind it. Until
// it is called, no plugin is installed and none runs.
func UseStore(s *Service, open func() *store.Store, edit Editor) {
	s.open, s.edit = open, edit
}

const (
	// maxManifest caps a repository's manifest.
	maxManifest = 4 << 20
	// maxScrapers caps the plugins read from one manifest, as Nuvio does.
	maxScrapers = 512
	// refreshAfter is how old a repository's plugin list gets before it is
	// read again. Nuvio refreshes about as often.
	refreshAfter = 24 * time.Hour
	// retryAfter is how long a repository that didn't answer is left alone.
	retryAfter = 5 * time.Minute
)

// Repository is an installed plugin repository, for the settings pane: where
// it is (its name and manifest URL are the source of its plugins), whether
// it's on, and its plugins as its manifest last listed them.
type Repository struct {
	URL     string `json:"url"`
	Name    string `json:"name"`
	Enabled bool   `json:"enabled"`
	// Supported is false for a repository this device can't run, such as
	// Android's Cloudstream ones. It stays in the list, so syncing doesn't
	// delete it from the phone.
	Supported bool   `json:"supported"`
	Version   string `json:"version"`
	// FetchedAt is when the plugin list was read, in ms since the epoch, or
	// 0 if it hasn't been yet.
	FetchedAt int64               `json:"fetchedAt"`
	Plugins   []store.PluginEntry `json:"plugins"`
}

// Overview is what the settings pane shows for a profile.
type Overview struct {
	// Kids is true for a kids profile: plugins aren't offered, and the rest
	// is empty.
	Kids bool `json:"kids"`
	// Enabled is the master switch.
	Enabled      bool         `json:"enabled"`
	Repositories []Repository `json:"repositories"`
}

func (s *Service) store() (*store.Store, error) {
	if s.open == nil || s.edit == nil {
		return nil, ErrNoStore
	}
	db := s.open()
	if db == nil {
		return nil, ErrNoStore
	}
	return db, nil
}

// Overview returns profile id's switch, repositories and their plugins.
func (s *Service) Overview(ctx context.Context, profileID uint64) (Overview, error) {
	db, err := s.store()
	if err != nil {
		return Overview{}, err
	}
	profile, err := db.Profile(profileID)
	if err != nil {
		return Overview{}, err
	}
	if profile.Kids {
		return Overview{Kids: true, Repositories: []Repository{}}, nil
	}
	config, err := db.PluginConfig(profileID)
	if err != nil {
		return Overview{}, err
	}
	repos, err := db.PluginRepos(profileID)
	if err != nil {
		return Overview{}, err
	}
	out := Overview{Enabled: config.Enabled, Repositories: make([]Repository, len(repos))}
	for i, r := range repos {
		out.Repositories[i] = repositoryView(r, config.Caches[r.URL])
	}
	return out, nil
}

func repositoryView(r store.PluginRepo, cache store.PluginCache) Repository {
	plugins := cache.Plugins
	if plugins == nil {
		plugins = []store.PluginEntry{}
	}
	name := r.Name
	if name == "" {
		name = cache.Name
	}
	if name == "" {
		name = hostOf(r.URL)
	}
	return Repository{
		URL: r.URL, Name: name, Enabled: r.Enabled, Supported: r.Runnable(),
		Version: cache.Version, FetchedAt: cache.FetchedAt, Plugins: plugins,
	}
}

func hostOf(link string) string {
	if u, err := url.Parse(link); err == nil && u.Host != "" {
		return u.Host
	}
	return link
}

// Installed is the plugins to ask, for the profile in use: the enabled
// plugins of its enabled repositories, in repository order, with their
// settings. It is empty when plugins are off for the profile (the default),
// when it is a kids profile, and when no store is set. A plugin id that two
// repositories list is asked once, from the first. It reads the stored list
// only: Refresh brings it up to date.
func (s *Service) Installed(ctx context.Context) ([]Plugin, error) {
	out := []Plugin{}
	db, err := s.store()
	if err != nil {
		return out, nil
	}
	profile, ok, err := db.ProfileInUse()
	if err != nil || !ok || profile.Kids {
		return out, err
	}
	config, err := db.PluginConfig(profile.ID)
	if err != nil || !config.Enabled {
		return out, err
	}
	repos, err := db.PluginRepos(profile.ID)
	if err != nil {
		return out, err
	}
	seen := map[string]bool{}
	for _, r := range repos {
		if !r.Enabled || !r.Runnable() {
			continue
		}
		for _, e := range config.Caches[r.URL].Plugins {
			if !e.Enabled || seen[e.ID] {
				continue
			}
			seen[e.ID] = true
			out = append(out, Plugin{
				ID: e.ID, Name: e.Name, Version: e.Version, URL: e.File,
				SupportedTypes: e.SupportedTypes, Settings: e.Settings,
			})
		}
	}
	return out, nil
}

// mutate runs edit on profile id's plugins through the editor, which asks
// for what changing the profile needs, and refuses a kids profile outright.
func (s *Service) mutate(profileID uint64, edit func(db *store.Store) error) error {
	if _, err := s.store(); err != nil {
		return err
	}
	return s.edit(profileID, func(db *store.Store) error {
		profile, err := db.Profile(profileID)
		if err != nil {
			return err
		}
		if profile.Kids {
			return ErrKids
		}
		return edit(db)
	})
}

// SetEnabled turns the master switch on or off. The settings pane asks first
// (the warning dialog); Go only records the answer.
func (s *Service) SetEnabled(ctx context.Context, profileID uint64, enabled bool) error {
	return s.mutate(profileID, func(db *store.Store) error { return db.SetPluginsEnabled(profileID, enabled) })
}

// on is mutate for a change that makes sense only while plugins are on.
func (s *Service) on(profileID uint64, edit func(db *store.Store) error) error {
	return s.mutate(profileID, func(db *store.Store) error {
		config, err := db.PluginConfig(profileID)
		if err != nil {
			return err
		}
		if !config.Enabled {
			return ErrOff
		}
		return edit(db)
	})
}

// InstallRepository adds the plugin repository whose manifest is at link to
// profile id's list, and reads its plugins. A bare repository address gets
// "/manifest.json". The manifest is read first, and nothing is saved unless
// it lists a plugin this device can run.
func (s *Service) InstallRepository(ctx context.Context, profileID uint64, link string) (Repository, error) {
	link, err := manifestAddress(link)
	if err != nil {
		return Repository{}, err
	}
	// Refuse before asking the network: off, a kids profile, a locked
	// profile, or one that is there already.
	if err := s.on(profileID, func(db *store.Store) error {
		repos, err := db.PluginRepos(profileID)
		if err != nil {
			return err
		}
		if slices.ContainsFunc(repos, func(r store.PluginRepo) bool { return r.URL == link }) {
			return fmt.Errorf("%w: %s", store.ErrPluginRepoInstalled, link)
		}
		return nil
	}); err != nil {
		return Repository{}, err
	}
	m, err := s.manifest(ctx, link)
	if err != nil {
		return Repository{}, err
	}
	repo := store.PluginRepo{URL: link, Name: cleanName(m.Name, link), Enabled: true, Type: store.PluginTypeJS}
	cache := cacheOf(m, time.Now())
	if err := s.on(profileID, func(db *store.Store) error { return db.InstallPluginRepo(profileID, repo, cache) }); err != nil {
		return Repository{}, err
	}
	return repositoryView(repo, cache), nil
}

// manifestAddress turns what the user typed into a manifest URL, as Nuvio's
// apps do: "https://" if no scheme, no fragment, and "/manifest.json" unless
// the path already names a .json file.
func manifestAddress(input string) (string, error) {
	input = strings.TrimSpace(input)
	if input == "" {
		return "", ErrBadAddress
	}
	if !strings.Contains(input, "://") {
		input = "https://" + input
	}
	u, err := url.Parse(input)
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" || u.User != nil {
		return "", ErrBadAddress
	}
	u.Fragment = ""
	if !strings.HasSuffix(strings.ToLower(u.Path), ".json") {
		u.Path = strings.TrimRight(u.Path, "/") + "/manifest.json"
		u.RawPath = ""
	}
	return u.String(), nil
}

// manifest reads and parses the manifest at link. It is an error unless it
// lists at least one plugin for this device.
func (s *Service) manifest(ctx context.Context, link string) (Manifest, error) {
	data, err := s.get(ctx, link, maxManifest)
	if err != nil {
		return Manifest{}, err
	}
	m, err := ParseManifest(data, link)
	if err != nil || len(m.Scrapers) == 0 {
		return Manifest{}, ErrNotRepository
	}
	if len(m.Scrapers) > maxScrapers {
		m.Scrapers = m.Scrapers[:maxScrapers]
	}
	return m, nil
}

func cacheOf(m Manifest, at time.Time) store.PluginCache {
	cache := store.PluginCache{Name: m.Name, Version: m.Version, FetchedAt: at.UnixMilli(), Plugins: make([]store.PluginEntry, len(m.Scrapers))}
	for i, sc := range m.Scrapers {
		cache.Plugins[i] = store.PluginEntry{
			ID: sc.ID, Name: sc.Name, Description: sc.Description, Version: sc.Version, Author: sc.Author,
			SupportedTypes: append([]string{}, sc.SupportedTypes...), File: sc.File, Enabled: sc.Enabled,
		}
	}
	return cache
}

// cleanName is a repository's name for the list: the manifest's, trimmed
// and cut, or its host.
func cleanName(name, link string) string {
	name = strings.TrimSpace(name)
	if name == "" {
		return hostOf(link)
	}
	if r := []rune(name); len(r) > 80 {
		name = string(r[:80])
	}
	return name
}

// RemoveRepository removes a repository and its plugins from profile id.
func (s *Service) RemoveRepository(ctx context.Context, profileID uint64, link string) error {
	return s.mutate(profileID, func(db *store.Store) error { return db.RemovePluginRepo(profileID, link) })
}

// EnableRepository turns a whole repository on or off.
func (s *Service) EnableRepository(ctx context.Context, profileID uint64, link string, enabled bool) error {
	return s.mutate(profileID, func(db *store.Store) error { return db.EnablePluginRepo(profileID, link, enabled) })
}

// EnablePlugin turns one plugin on or off.
func (s *Service) EnablePlugin(ctx context.Context, profileID uint64, pluginID string, enabled bool) error {
	return s.mutate(profileID, func(db *store.Store) error { return db.EnablePlugin(profileID, pluginID, enabled) })
}

// SetSettings keeps settings as a plugin's SCRAPER_SETTINGS, which some
// plugins read their options from; nil clears them. The settings pane has no
// editor for them yet.
func (s *Service) SetSettings(ctx context.Context, profileID uint64, pluginID string, settings map[string]any) error {
	return s.mutate(profileID, func(db *store.Store) error { return db.SetPluginSettings(profileID, pluginID, settings) })
}

// Refresh reads again the plugin list of the profile's repositories that
// have none yet (such as ones that came from Nuvio) or whose list is a day
// old, or all of them if force. A repository that doesn't answer keeps its
// last list. It returns how many were read, and does nothing, with no
// network request, for a kids profile or while plugins are off.
func (s *Service) Refresh(ctx context.Context, profileID uint64, force bool) (int, error) {
	db, err := s.store()
	if err != nil {
		return 0, err
	}
	profile, err := db.Profile(profileID)
	if err != nil || profile.Kids {
		return 0, err
	}
	config, err := db.PluginConfig(profileID)
	if err != nil || !config.Enabled {
		return 0, err
	}
	repos, err := db.PluginRepos(profileID)
	if err != nil {
		return 0, err
	}
	now := time.Now()
	var due []store.PluginRepo
	for _, r := range repos {
		cache, have := config.Caches[r.URL]
		stale := !have || now.Sub(time.UnixMilli(cache.FetchedAt)) > refreshAfter
		if r.Enabled && r.Runnable() && (force || stale) && s.mayRetry(r.URL, now) {
			due = append(due, r)
		}
	}
	var (
		wg   sync.WaitGroup
		mu   sync.Mutex
		done int
		errs []error
		gate = make(chan struct{}, 4)
	)
	for _, r := range due {
		wg.Go(func() {
			gate <- struct{}{}
			defer func() { <-gate }()
			m, err := s.manifest(ctx, r.URL)
			if err == nil {
				err = db.SetPluginCache(profileID, r.URL, cacheOf(m, time.Now()))
			}
			mu.Lock()
			defer mu.Unlock()
			if err != nil {
				s.failed(r.URL, time.Now())
				errs = append(errs, err)
				return
			}
			done++
		})
	}
	wg.Wait()
	if ctx.Err() != nil {
		return done, ctx.Err()
	}
	// One that went away meanwhile isn't a failure worth telling.
	errs = slices.DeleteFunc(errs, func(err error) bool { return errors.Is(err, store.ErrPluginRepoNotFound) })
	return done, errors.Join(errs...)
}

func (s *Service) mayRetry(link string, now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	at, failed := s.failedAt[link]
	return !failed || now.Sub(at) > retryAfter
}

func (s *Service) failed(link string, now time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.failedAt[link] = now
}

// ManifestPlugins lists the plugins a manifest offers this device, for tools
// and tests. It isn't a method, so Wails doesn't bind it.
func ManifestPlugins(ctx context.Context, s *Service, link string) ([]Plugin, error) {
	m, err := s.manifest(ctx, link)
	if err != nil {
		return nil, err
	}
	out := make([]Plugin, 0, len(m.Scrapers))
	for _, sc := range m.Scrapers {
		if sc.Enabled {
			out = append(out, Plugin{ID: sc.ID, Name: sc.Name, Version: sc.Version, URL: sc.File, SupportedTypes: sc.SupportedTypes})
		}
	}
	return out, nil
}

// RunUnchecked asks plugin without checking that it's installed, for the
// plugins tool. It isn't a method, so Wails doesn't bind it, and the app
// never calls it.
func RunUnchecked(ctx context.Context, s *Service, plugin Plugin, query Query) ([]Stream, error) {
	return s.run(ctx, plugin, query)
}
