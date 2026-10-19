package store

import (
	"fmt"
	"sort"

	bolt "go.etcd.io/bbolt"
)

// LibraryItem is a title saved to a profile's library. Fields follow Nuvio's
// library_items; times are ms since epoch.
type LibraryItem struct {
	ContentID    string   `json:"contentId"`
	ContentType  string   `json:"contentType"`
	Name         string   `json:"name"`
	Poster       string   `json:"poster,omitempty"`
	PosterShape  string   `json:"posterShape,omitempty"`
	Background   string   `json:"background,omitempty"`
	Description  string   `json:"description,omitempty"`
	ReleaseInfo  string   `json:"releaseInfo,omitempty"`
	IMDBRating   *float64 `json:"imdbRating,omitempty"`
	Genres       []string `json:"genres,omitempty"`
	AddonBaseURL string   `json:"addonBaseUrl,omitempty"`
	AddedAt      int64    `json:"addedAt"`
}

func libraryKey(contentID, contentType string) string {
	return string(joinKey(contentID, contentType))
}

// Library returns profile id's library, most recently added first.
func (s *Store) Library(id uint64) ([]LibraryItem, error) {
	items := []LibraryItem{}
	err := s.view(id, func(p *bolt.Bucket) error {
		return each(p.Bucket(bucketLibrary), func(item LibraryItem) { items = append(items, item) })
	})
	sort.SliceStable(items, func(i, j int) bool { return items[i].AddedAt > items[j].AddedAt })
	return items, err
}

// SaveLibraryItem adds item to profile id's library, or updates it.
func (s *Store) SaveLibraryItem(id uint64, item LibraryItem) error {
	if item.ContentID == "" || item.ContentType == "" {
		return fmt.Errorf("%w: library item needs a content ID and type", ErrInvalidItem)
	}
	key := libraryKey(item.ContentID, item.ContentType)
	return s.update(id, func(p *bolt.Bucket) error {
		if err := put(p.Bucket(bucketLibrary), []byte(key), item); err != nil {
			return err
		}
		return enqueue(p, SurfaceLibrary, OpUpsert, key, item)
	})
}

// RemoveLibraryItem removes a title from profile id's library.
func (s *Store) RemoveLibraryItem(id uint64, contentID, contentType string) error {
	key := libraryKey(contentID, contentType)
	return s.update(id, func(p *bolt.Bucket) error {
		return remove(p, bucketLibrary, SurfaceLibrary, []byte(key))
	})
}
