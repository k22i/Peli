package store

import (
	"context"
	"os"
	"path/filepath"

	"github.com/adrg/xdg"
	"github.com/wailsapp/wails/v3/pkg/application"
)

// DefaultPath is where the database lives: Cove/cove.db in the OS app-data
// directory (~/Library/Application Support, %LOCALAPPDATA% or
// $XDG_DATA_HOME), or in $COVE_DATA_DIR when set.
func DefaultPath() string {
	dir := os.Getenv("COVE_DATA_DIR")
	if dir == "" {
		dir = filepath.Join(xdg.DataHome, "Cove")
	}
	return filepath.Join(dir, "cove.db")
}

// Service is the Wails service the frontend calls for local data. It opens the
// database at startup and closes it at shutdown. Sync bookkeeping (cursors and
// pushes) stays on Store, for the sync module (#28).
type Service struct {
	path  string
	store *Store
}

// NewService returns a service for the database at path.
func NewService(path string) *Service {
	return &Service{path: path}
}

func (s *Service) ServiceStartup(context.Context, application.ServiceOptions) error {
	store, err := Open(s.path)
	if err != nil {
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

// CreateProfile adds a profile and returns it with its new ID.
func (s *Service) CreateProfile(profile Profile) (Profile, error) {
	return s.store.CreateProfile(profile)
}

// UpdateProfile saves a profile's name, avatar and Nuvio link.
func (s *Service) UpdateProfile(profile Profile) error { return s.store.UpdateProfile(profile) }

// DeleteProfile deletes a profile and everything in it.
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

// Addons returns a profile's addons in order.
func (s *Service) Addons(profileID uint64) ([]Addon, error) { return s.store.Addons(profileID) }

// SetAddons replaces a profile's addons, in order.
func (s *Service) SetAddons(profileID uint64, addons []Addon) error {
	return s.store.SetAddons(profileID, addons)
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
