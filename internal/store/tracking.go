package store

import (
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"slices"

	bolt "go.etcd.io/bbolt"
)

// Tracking (#71): a profile's connections to SIMKL and AniList, kept in its
// bucket so they go when it does. The tokens are in the keychain (ADR-0007);
// these are only what the Settings rows show and the import's bookkeeping.
//
//	profiles/<id>      tracking → Tracking
//	  tracking-outbox/ <sequence> → TrackingJob
type Tracking struct {
	Simkl   *SimklLink   `json:"simkl,omitempty"`
	AniList *AniListLink `json:"anilist,omitempty"`
}

// SimklLink is a connected SIMKL account.
type SimklLink struct {
	User string `json:"user"`
	// When the access token expires, in Unix ms; it's refreshed before.
	AccessExpires int64 `json:"accessExpires"`
	// The refresh token stopped working, or the token is read-only: connect
	// again.
	NeedsReconnect bool `json:"needsReconnect,omitempty"`
	// The history import (#74): SIMKL's activities "all" time the last full
	// import read, which the next one asks changes after. Empty until the
	// first import has finished.
	Imported string `json:"imported,omitempty"`
	// When the last import ran, in Unix ms.
	ImportedAt int64 `json:"importedAt,omitempty"`
}

// AniListLink is a connected AniList account.
type AniListLink struct {
	UserID int    `json:"userId"`
	User   string `json:"user"`
	// When the token expires, in Unix ms (a year after it was issued).
	// AniList tokens don't refresh.
	Expires        int64 `json:"expires"`
	NeedsReconnect bool  `json:"needsReconnect,omitempty"`
	// The list import (#105): entries updated after this (Unix seconds,
	// AniList's updatedAt) are read on the next import.
	Imported   int64 `json:"imported,omitempty"`
	ImportedAt int64 `json:"importedAt,omitempty"`
}

// TrackingJob is a scrobble or list update that couldn't be sent, kept to
// send later. Payload is the tracking package's own.
type TrackingJob struct {
	Seq      uint64          `json:"seq"`
	Service  string          `json:"service"`
	Payload  json.RawMessage `json:"payload"`
	Attempts int             `json:"attempts"`
	// Unix ms; when it was first kept.
	Created int64 `json:"created"`
	// Unix ms; not before then.
	NextAt int64 `json:"nextAt"`
}

var (
	keyTracking          = []byte("tracking")
	bucketTrackingOutbox = []byte("tracking-outbox")
	keyTokenOwners       = []byte("tracking-token-owners")
	errNoJob             = errors.New("store: no such tracking job")
)

// Tracking returns profile id's connections.
func (s *Store) Tracking(id uint64) (Tracking, error) {
	var t Tracking
	err := s.view(id, func(p *bolt.Bucket) error {
		return decodeOnto(p.Get(keyTracking), &t)
	})
	return t, err
}

// UpdateTracking changes profile id's connections with fn, in one
// transaction, so a sign-in and an import never undo each other.
func (s *Store) UpdateTracking(id uint64, fn func(t *Tracking) error) error {
	return s.update(id, func(p *bolt.Bucket) error {
		var t Tracking
		if err := decodeOnto(p.Get(keyTracking), &t); err != nil {
			return err
		}
		if err := fn(&t); err != nil {
			return err
		}
		return put(p, keyTracking, t)
	})
}

// QueueTrackingJob keeps job for profile id, giving it the next sequence
// number.
func (s *Store) QueueTrackingJob(id uint64, job TrackingJob) (TrackingJob, error) {
	err := s.update(id, func(p *bolt.Bucket) error {
		b, err := p.CreateBucketIfNotExists(bucketTrackingOutbox)
		if err != nil {
			return err
		}
		if job.Seq, err = b.NextSequence(); err != nil {
			return err
		}
		return put(b, u64(job.Seq), job)
	})
	return job, err
}

// TrackingJobs returns profile id's kept jobs, oldest first.
func (s *Store) TrackingJobs(id uint64) ([]TrackingJob, error) {
	jobs := []TrackingJob{}
	err := s.view(id, func(p *bolt.Bucket) error {
		b := p.Bucket(bucketTrackingOutbox)
		if b == nil {
			return nil
		}
		return each(b, func(job TrackingJob) { jobs = append(jobs, job) })
	})
	return jobs, err
}

// SaveTrackingJob replaces a kept job (after a failed attempt).
func (s *Store) SaveTrackingJob(id uint64, job TrackingJob) error {
	return s.update(id, func(p *bolt.Bucket) error {
		b := p.Bucket(bucketTrackingOutbox)
		if b == nil || b.Get(u64(job.Seq)) == nil {
			return fmt.Errorf("%w: %d", errNoJob, job.Seq)
		}
		return put(b, u64(job.Seq), job)
	})
}

// DropTrackingJobs removes kept jobs: those numbered seqs, or every one of
// service's when seqs is empty (on disconnecting).
func (s *Store) DropTrackingJobs(id uint64, service string, seqs ...uint64) error {
	return s.update(id, func(p *bolt.Bucket) error {
		b := p.Bucket(bucketTrackingOutbox)
		if b == nil {
			return nil
		}
		if len(seqs) > 0 {
			for _, seq := range seqs {
				if err := b.Delete(u64(seq)); err != nil {
					return err
				}
			}
			return nil
		}
		var drop [][]byte
		err := b.ForEach(func(k, data []byte) error {
			var job TrackingJob
			if err := json.Unmarshal(data, &job); err != nil {
				return err
			}
			if job.Service == service {
				drop = append(drop, append([]byte(nil), k...))
			}
			return nil
		})
		if err != nil {
			return err
		}
		for _, k := range drop {
			if err := b.Delete(k); err != nil {
				return err
			}
		}
		return nil
	})
}

// TrackedProfiles returns the IDs of every profile with a connection, for
// clearing tokens left by deleted profiles.
func (s *Store) TrackedProfiles() (map[uint64]bool, error) {
	ids := map[uint64]bool{}
	err := s.db.View(func(tx *bolt.Tx) error {
		return tx.Bucket(bucketProfiles).ForEachBucket(func(k []byte) error {
			p := tx.Bucket(bucketProfiles).Bucket(k)
			var t Tracking
			if err := decodeOnto(p.Get(keyTracking), &t); err != nil {
				return err
			}
			if t.Simkl != nil || t.AniList != nil {
				ids[binary.BigEndian.Uint64(k)] = true
			}
			return nil
		})
	})
	return ids, err
}

// TrackingTokenOwners returns the profiles that were given tracking tokens
// and haven't had them removed, whether or not they still exist.
func (s *Store) TrackingTokenOwners() ([]uint64, error) {
	var ids []uint64
	err := s.db.View(func(tx *bolt.Tx) error {
		return decodeOnto(tx.Bucket(bucketSettings).Get(keyTokenOwners), &ids)
	})
	return ids, err
}

// SetTrackingTokenOwner records whether profile id has tracking tokens in
// the keychain.
func (s *Store) SetTrackingTokenOwner(id uint64, has bool) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		settings := tx.Bucket(bucketSettings)
		var ids []uint64
		if err := decodeOnto(settings.Get(keyTokenOwners), &ids); err != nil {
			return err
		}
		ids = slices.DeleteFunc(ids, func(owner uint64) bool { return owner == id })
		if has {
			ids = append(ids, id)
		}
		return put(settings, keyTokenOwners, ids)
	})
}

// ImportWatched adds watched marks a tracker has (#74, #105) that profile id
// doesn't, and queues them for Nuvio like any other mark. The rules
// (ADR-0042): a mark is never removed by an import, a mark already here
// keeps its time, and progress is cleared only when it's older than the
// imported watch, so a rewatch under way is kept. It returns how many marks
// it added.
func (s *Store) ImportWatched(id uint64, items []WatchedItem) (int, error) {
	for _, item := range items {
		if item.ContentID == "" || item.ContentType == "" {
			return 0, fmt.Errorf("%w: watched item needs a content ID and type", ErrInvalidItem)
		}
	}
	added := 0
	err := s.update(id, func(p *bolt.Bucket) error {
		added = 0
		marks, progress := p.Bucket(bucketWatched), p.Bucket(bucketProgress)
		for _, item := range items {
			key := watchedKey(item.ContentID, item.Season, item.Episode)
			if marks.Get(key) != nil {
				continue
			}
			if err := put(marks, key, item); err != nil {
				return err
			}
			if err := enqueue(p, SurfaceWatched, OpUpsert, watchedPushKey(item.ContentID, item.Season, item.Episode), item); err != nil {
				return err
			}
			added++
			progressKey := ProgressKey(item.ContentID, item.Season, item.Episode)
			var entry Progress
			if data := progress.Get([]byte(progressKey)); data != nil {
				if err := json.Unmarshal(data, &entry); err != nil {
					return err
				}
				if entry.LastWatched < item.WatchedAt {
					if err := remove(p, bucketProgress, SurfaceProgress, []byte(progressKey), progressKey); err != nil {
						return err
					}
				}
			}
		}
		return nil
	})
	return added, err
}
