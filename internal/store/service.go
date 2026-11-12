package store

import (
	"context"
	"os"
	"path/filepath"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// DefaultPath is where the database lives: Peli/peli.db in the OS app-data
// directory (~/Library/Application Support, %LOCALAPPDATA% or
// $XDG_DATA_HOME), or in $PELI_DATA_DIR when set. On iOS it is peli.db in the
// app's own Application Support folder (datadir_ios.go).
func DefaultPath() string {
	dir := os.Getenv("PELI_DATA_DIR")
	if dir == "" {
		dir = dataDir()
	}
	return filepath.Join(dir, "peli.db")
}

// Service is the Wails service the frontend calls for local data. It opens the
// database at startup and closes it at shutdown. Sync bookkeeping (cursors and
// pushes) stays on Store, for the sync module (#28).
type Service struct {
	path   string
	store  *Store
	queued func(profileID uint64)
}

// NewService returns a service for the database at path.
func NewService(path string) *Service {
	return &Service{path: path}
}

// Opened returns service's database, for other Go services, once it has
// started. A function rather than a method, so Wails doesn't bind it for the
// frontend.
func Opened(service *Service) *Store { return service.store }

// NotifyQueued has service call fn after each write that queued a push to
// Nuvio, for the push loop (#30); see Store.OnQueued. Call it before the
// service starts. A function rather than a method, so Wails doesn't bind it.
func NotifyQueued(service *Service, fn func(profileID uint64)) { service.queued = fn }

func (s *Service) ServiceStartup(context.Context, application.ServiceOptions) error {
	store, err := Open(s.path)
	if err != nil {
		return err
	}
	store.OnQueued(s.queued)
	if err := store.UseBuiltins(Builtins); err != nil {
		store.Close()
		return err
	}
	s.store = store
	return nil
}

func (s *Service) ServiceShutdown() error {
	if s.store == nil {
		return nil
	}
	return s.store.Close()
}

// Profiles returns every profile, oldest first.
func (s *Service) Profiles() ([]Profile, error) { return s.store.Profiles() }

// CurrentProfile returns the profile in use, creating a local Guest profile
// on first launch.
func (s *Service) CurrentProfile() (Profile, error) { return s.store.CurrentProfile() }

// SwitchToGuest makes the Guest profile the one in use, creating it if there
// is none, and returns it.
// It refuses while a kids profile is in use (#26): leaving one goes through
// the account service, which asks for the parent PIN.
func (s *Service) SwitchToGuest() (Profile, error) {
	if err := s.notKids(); err != nil {
		return Profile{}, err
	}
	return s.store.SwitchToGuest()
}

// SetCurrentProfile makes a profile the one in use, from the picker (#24).
// It is remembered across launches. Like SwitchToGuest, it refuses while a
// kids profile is in use.
func (s *Service) SetCurrentProfile(profileID uint64) error {
	if err := s.notKids(); err != nil {
		return err
	}
	return s.store.SetCurrentProfile(profileID)
}

// notKids returns ErrKidsProfile if the profile in use is a kids profile.
func (s *Service) notKids() error {
	kids, err := s.store.currentIsKids()
	if err != nil {
		return err
	}
	if kids {
		return ErrKidsProfile
	}
	return nil
}

// CreateProfile adds a profile and returns it with its new ID.
func (s *Service) CreateProfile(profile Profile) (Profile, error) {
	return s.store.CreateProfile(profile)
}

// UpdateProfile saves a profile's name, avatar and Nuvio link.
func (s *Service) UpdateProfile(profile Profile) error { return s.store.UpdateProfile(profile) }

// DeleteProfile deletes a profile and everything in it. If it was current,
// the oldest profile left becomes current.
func (s *Service) DeleteProfile(profileID uint64) error { return s.store.DeleteProfile(profileID) }

// Library returns a profile's library, most recently added first.
func (s *Service) Library(profileID uint64) ([]LibraryItem, error) {
	return s.store.Library(profileID)
}

// SaveLibraryItem adds a title to a profile's library, or updates it.
func (s *Service) SaveLibraryItem(profileID uint64, item LibraryItem) error {
	return s.store.SaveLibraryItem(profileID, item)
}

// RemoveLibraryItem removes a title from a profile's library.
func (s *Service) RemoveLibraryItem(profileID uint64, contentID, contentType string) error {
	return s.store.RemoveLibraryItem(profileID, contentID, contentType)
}

// LastWatched returns when a profile last watched each title, by content ID.
func (s *Service) LastWatched(profileID uint64) (map[string]int64, error) {
	return s.store.LastWatched(profileID)
}

// ContinueWatching returns a profile's unfinished progress, most recently
// watched first, one entry per title.
func (s *Service) ContinueWatching(profileID uint64) ([]Progress, error) {
	return s.store.ContinueWatching(profileID)
}

// TitleProgress returns a profile's progress in a film or a series' episodes.
func (s *Service) TitleProgress(profileID uint64, contentID string) ([]Progress, error) {
	return s.store.TitleProgress(profileID, contentID)
}

// SaveProgress stores progress and returns it with its key set.
func (s *Service) SaveProgress(profileID uint64, entry Progress) (Progress, error) {
	return s.store.SaveProgress(profileID, entry)
}

// RemoveProgress removes a progress entry by key.
func (s *Service) RemoveProgress(profileID uint64, key string) error {
	return s.store.RemoveProgress(profileID, key)
}

// ClearContinueWatching takes a title out of Continue Watching by removing
// its unfinished progress. It does not mark it watched.
func (s *Service) ClearContinueWatching(profileID uint64, contentID string) error {
	_, err := s.store.ClearContinueWatching(profileID, contentID)
	return err
}

// Watched returns everything a profile has watched.
func (s *Service) Watched(profileID uint64) ([]WatchedItem, error) {
	return s.store.Watched(profileID)
}

// TitleWatched returns what a profile has watched of one title.
func (s *Service) TitleWatched(profileID uint64, contentID string) ([]WatchedItem, error) {
	return s.store.TitleWatched(profileID, contentID)
}

// MarkWatched marks a film, series or episode watched.
func (s *Service) MarkWatched(profileID uint64, item WatchedItem) error {
	return s.store.MarkWatched(profileID, item)
}

// UnmarkWatched removes a watched mark.
func (s *Service) UnmarkWatched(profileID uint64, contentID string, season, episode *int) error {
	return s.store.UnmarkWatched(profileID, contentID, season, episode)
}

// SetWatched marks or unmarks several films, episodes or series at once,
// clearing their progress, for a title page's season and series actions.
func (s *Service) SetWatched(profileID uint64, items []WatchedItem, watched bool) error {
	return s.store.SetWatched(profileID, items, watched)
}

// Addons returns a profile's addons in order.
func (s *Service) Addons(profileID uint64) ([]Addon, error) { return s.store.Addons(profileID) }

// VisibleAddons returns the enabled addons a profile may browse and search:
// all of them, or a kids profile's allowed ones (#26).
func (s *Service) VisibleAddons(profileID uint64) ([]Addon, error) {
	return s.store.VisibleAddons(profileID)
}

// CatalogVisible reports whether a profile may browse an addon's catalog
// (#26).
func (s *Service) CatalogVisible(profileID uint64, addon, contentType, catalog string) (bool, error) {
	return s.store.CatalogVisible(profileID, addon, contentType, catalog)
}

// HomeLayout returns a profile's home layout, or null if it has none: the
// order of Home's catalog and collection rows, pulled from Nuvio's apps
// (#35). Editing it goes through the account service.
func (s *Service) HomeLayout(profileID uint64) (*HomeLayout, error) {
	return s.store.HomeLayout(profileID)
}

// Collections returns the collections a profile may see on Home (#35): none
// for a kids profile.
func (s *Service) Collections(profileID uint64) ([]Collection, error) {
	return s.store.VisibleCollections(profileID)
}

// KidsScope returns what a kids profile may see (#26).
func (s *Service) KidsScope(profileID uint64) (KidsScope, error) {
	return s.store.KidsScope(profileID)
}

// ProfileSettings returns a profile's settings.
func (s *Service) ProfileSettings(profileID uint64) (ProfileSettings, error) {
	return s.store.ProfileSettings(profileID)
}

// SaveProfileSettings replaces a profile's settings.
func (s *Service) SaveProfileSettings(profileID uint64, settings ProfileSettings) error {
	return s.store.SaveProfileSettings(profileID, settings)
}

// ChosenSource returns the source a profile last played a show from (#58),
// or null for none.
func (s *Service) ChosenSource(profileID uint64, contentID string) (*ChosenSource, error) {
	return s.store.ChosenSource(profileID, contentID)
}

// SetChosenSource remembers the source a profile played a show from, or
// forgets it when chosen is null.
func (s *Service) SetChosenSource(profileID uint64, contentID string, chosen *ChosenSource) error {
	return s.store.SetChosenSource(profileID, contentID, chosen)
}

// TitleAdjustments returns how a profile plays a title (a show's id or a
// film's) when it isn't the profile's defaults, or null.
func (s *Service) TitleAdjustments(profileID uint64, contentID string) (*TitleAdjustments, error) {
	return s.store.TitleAdjustments(profileID, contentID)
}

// SetTitleAdjustments keeps how a profile plays a title, or forgets it when
// adjustments is null or empty.
func (s *Service) SetTitleAdjustments(profileID uint64, contentID string, adjustments *TitleAdjustments) error {
	return s.store.SetTitleAdjustments(profileID, contentID, adjustments)
}

// AdjustedTitles counts the titles a profile plays its own way.
func (s *Service) AdjustedTitles(profileID uint64) (int, error) {
	return s.store.AdjustedTitles(profileID)
}

// ClearTitleAdjustments has every title of a profile follow its defaults.
func (s *Service) ClearTitleAdjustments(profileID uint64) error {
	return s.store.ClearTitleAdjustments(profileID)
}

// RecentSearches returns a profile's last searches, newest first.
func (s *Service) RecentSearches(profileID uint64) ([]string, error) {
	return s.store.RecentSearches(profileID)
}

// SetRecentSearches replaces a profile's recent searches (newest first, at
// most eight); an empty list forgets them.
func (s *Service) SetRecentSearches(profileID uint64, recent []string) error {
	return s.store.SetRecentSearches(profileID, recent)
}

// DeviceSettings returns this device's settings.
func (s *Service) DeviceSettings() (DeviceSettings, error) { return s.store.DeviceSettings() }

// SaveDeviceSettings replaces this device's settings.
func (s *Service) SaveDeviceSettings(settings DeviceSettings) error {
	return s.store.SaveDeviceSettings(settings)
}

// CacheGet returns the cached string at key, or nil.
func (s *Service) CacheGet(key string) (*string, error) {
	value, ok, err := s.store.CacheGet(key)
	if err != nil || !ok {
		return nil, err
	}
	str := string(value)
	return &str, nil
}

// CacheSet caches value at key.
func (s *Service) CacheSet(key, value string) error {
	return s.store.CacheSet(key, []byte(value))
}

// CacheDelete removes key from the cache.
func (s *Service) CacheDelete(key string) error { return s.store.CacheDelete(key) }
