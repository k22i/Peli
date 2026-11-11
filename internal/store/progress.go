package store

import (
	"fmt"
	"sort"

	bolt "go.etcd.io/bbolt"
)

// Progress is how far a profile got in a film or episode. Fields follow
// Nuvio's watch_progress; positions are ms, times ms since epoch.
type Progress struct {
	// Built by SaveProgress the way Nuvio builds it: the content ID, or
	// "<content id>_s<season>e<episode>" for an episode.
	Key         string `json:"key"`
	ContentID   string `json:"contentId"`
	ContentType string `json:"contentType"`
	VideoID     string `json:"videoId"`
	Season      *int   `json:"season,omitempty"`
	Episode     *int   `json:"episode,omitempty"`
	Position    int64  `json:"position"`
	Duration    int64  `json:"duration"`
	LastWatched int64  `json:"lastWatched"`
}

// ProgressKey returns Nuvio's progress key for a title or episode.
func ProgressKey(contentID string, season, episode *int) string {
	if season == nil || episode == nil {
		return contentID
	}
	return fmt.Sprintf("%s_s%de%d", contentID, *season, *episode)
}

// finished matches Nuvio, which marks an item watched at 90 %.
func (p Progress) finished() bool {
	return p.Duration > 0 && p.Position*10 >= p.Duration*9
}

// ContinueWatching returns profile id's unfinished progress, most recently
// watched first, with only the latest entry per title.
func (s *Store) ContinueWatching(id uint64) ([]Progress, error) {
	all := []Progress{}
	err := s.view(id, func(p *bolt.Bucket) error {
		return each(p.Bucket(bucketProgress), func(entry Progress) { all = append(all, entry) })
	})
	if err != nil {
		return nil, err
	}
	sort.SliceStable(all, func(i, j int) bool { return all[i].LastWatched > all[j].LastWatched })

	entries := []Progress{}
	seen := map[string]bool{}
	for _, entry := range all {
		if seen[entry.ContentID] {
			continue
		}
		seen[entry.ContentID] = true
		if entry.Position > 0 && !entry.finished() {
			entries = append(entries, entry)
		}
	}
	return entries, nil
}

// TitleProgress returns profile id's progress in a film, or in every episode
// of a series, in key order.
func (s *Store) TitleProgress(id uint64, contentID string) ([]Progress, error) {
	entries := []Progress{}
	err := s.view(id, func(p *bolt.Bucket) error {
		return eachPrefix(p.Bucket(bucketProgress), []byte(contentID), func(entry Progress) {
			// The prefix also matches longer IDs ("tt12" and "tt123").
			if entry.ContentID == contentID {
				entries = append(entries, entry)
			}
		})
	})
	return entries, err
}

// SaveProgress stores progress for profile id, setting its Key.
func (s *Store) SaveProgress(id uint64, entry Progress) (Progress, error) {
	if entry.ContentID == "" || entry.ContentType == "" {
		return Progress{}, fmt.Errorf("%w: progress needs a content ID and type", ErrInvalidItem)
	}
	if entry.VideoID == "" {
		entry.VideoID = entry.ContentID
	}
	entry.Key = ProgressKey(entry.ContentID, entry.Season, entry.Episode)
	err := s.update(id, func(p *bolt.Bucket) error {
		if err := put(p.Bucket(bucketProgress), []byte(entry.Key), entry); err != nil {
			return err
		}
		return enqueue(p, SurfaceProgress, OpUpsert, entry.Key, entry)
	})
	if err != nil {
		return Progress{}, err
	}
	return entry, nil
}

// RemoveProgress removes the progress entry with key from profile id.
func (s *Store) RemoveProgress(id uint64, key string) error {
	return s.update(id, func(p *bolt.Bucket) error {
		return remove(p, bucketProgress, SurfaceProgress, []byte(key), key)
	})
}

// ClearContinueWatching takes a title out of profile id's Continue Watching
// without marking it watched: it removes the title's unfinished progress, in
// one transaction, and queues the deletes like any removal.
//
// Nuvio has no hidden flag to sync: its progress is rows, and its apps
// "remove from Continue Watching" by deleting them. Deleting is also what
// makes the title come back when it is played again, since playing saves
// fresh progress. A flag would be local to this device, and would have to
// be reset on play. Finished entries stay, as they are what "watched"
// reads, and Continue Watching leaves them out anyway.
func (s *Store) ClearContinueWatching(id uint64, contentID string) (int, error) {
	removed := 0
	err := s.update(id, func(p *bolt.Bucket) error {
		var keys []string
		err := eachPrefix(p.Bucket(bucketProgress), []byte(contentID), func(entry Progress) {
			// The prefix also matches longer IDs ("tt12" and "tt123").
			if entry.ContentID == contentID && !entry.finished() {
				keys = append(keys, entry.Key)
			}
		})
		if err != nil {
			return err
		}
		for _, key := range keys {
			if err := remove(p, bucketProgress, SurfaceProgress, []byte(key), key); err != nil {
				return err
			}
		}
		removed = len(keys)
		return nil
	})
	return removed, err
}
