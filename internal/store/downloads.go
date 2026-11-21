package store

import (
	"cmp"
	"errors"
	"fmt"
	"slices"
	"time"

	bolt "go.etcd.io/bbolt"
)

// Download is one file Peli fetches for offline viewing, or fetched one
// (#85, ADR-0064): the stream the user picked, where its bytes are, and how
// far the job got. Downloads belong to the device rather than to a profile:
// one bucket outside the profiles, never synced to Nuvio (ADR-0038). Each one
// is shown only to the profile that started it, so two profiles downloading
// the same episode make two copies.
//
//	downloads <id> → Download
type Download struct {
	// ID is 32 hex characters, made at random.
	ID        string `json:"id"`
	ProfileID uint64 `json:"profileId"`
	// What it is, enough to play it and report progress offline.
	ContentID   string `json:"contentId"`   // "tt0903747", "kitsu:123"
	ContentType string `json:"contentType"` // "movie" | "series" (the addon type)
	VideoID     string `json:"videoId"`     // the episode's video id, or ContentID for a film
	Season      int    `json:"season"`      // 0 for a film
	Episode     int    `json:"episode"`     // 0 for a film
	Name        string `json:"name"`        // the title's name
	EpisodeName string `json:"episodeName"` // "" for a film
	Poster      string `json:"poster"`      // URL, shown while online; may be ""
	MetaAddon   string `json:"metaAddon"`   // the addon that served the details (the kids rule)
	// Which stream, as the picker labels it.
	StreamSource      string `json:"streamSource"` // an addon's URL, or "plugin:<id>"
	StreamName        string `json:"streamName"`
	StreamDescription string `json:"streamDescription"`
	Resolution        string `json:"resolution"` // "1080p", "" when the stream didn't say
	// Request is the addon link the downloader resolves.
	Request DownloadRequest `json:"request"`
	// Where: Root is "" for the platform's default (iOS, whose container
	// moves between installs) and File is relative to it ("<id>/video.mkv"),
	// with ".part" appended while the job runs.
	Root      string             `json:"root"`
	File      string             `json:"file"`
	MimeType  string             `json:"mimeType"`
	Subtitles []DownloadSubtitle `json:"subtitles"`
	Segments  []DownloadSegment  `json:"segments"`
	// State is one of DownloadStates; Reason says why it waits or failed.
	State  string `json:"state"`
	Reason string `json:"reason"`
	Bytes  int64  `json:"bytes"` // on disk
	Total  int64  `json:"total"` // 0 until known
	// Unix ms. CreatedAt orders the queue, shared with the frontend's list;
	// DoneAt is 0 until the download is done.
	CreatedAt int64 `json:"createdAt"`
	UpdatedAt int64 `json:"updatedAt"`
	DoneAt    int64 `json:"doneAt"`
}

// DownloadRequest is the stream to fetch, as the addon's client handed it
// over: the link Resolve takes and the headers it needs.
type DownloadRequest struct {
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
}

// DownloadSubtitle is one subtitle to save beside the video, from the addon
// or the file.
type DownloadSubtitle struct {
	URL   string `json:"url"` // the addon's
	Lang  string `json:"lang"`
	Title string `json:"title"`
	File  string `json:"file"` // relative to Root; "" until saved
}

// DownloadSegment is an intro or credits marker, so they still skip offline.
type DownloadSegment struct {
	Kind  string  `json:"kind"`
	Start float64 `json:"start"`
	End   float64 `json:"end"`
}

// DownloadStates are a download's states, in the order a job moves through
// most of them: waiting for its turn, running, paused by the user, waiting for
// something (a network, a free slot), failed, or done.
var DownloadStates = []string{"queued", "downloading", "paused", "waiting", "failed", "done"}

// ErrDownloadNotFound is what the methods that name one download return when
// there is none with that id.
var ErrDownloadNotFound = errors.New("store: download not found")

var bucketDownloads = []byte("downloads")

// validate refuses a record that can't be a download: ErrInvalidItem, as for
// everything else in the store.
func (d Download) validate() error {
	if d.ID == "" {
		return fmt.Errorf("%w: a download needs an ID", ErrInvalidItem)
	}
	if d.ProfileID == 0 {
		return fmt.Errorf("%w: download %s has no profile", ErrInvalidItem, d.ID)
	}
	if d.VideoID == "" {
		return fmt.Errorf("%w: download %s has no video ID", ErrInvalidItem, d.ID)
	}
	if d.Request.URL == "" {
		return fmt.Errorf("%w: download %s has no request URL", ErrInvalidItem, d.ID)
	}
	if !slices.Contains(DownloadStates, d.State) {
		return fmt.Errorf("%w: download %s is %q", ErrInvalidItem, d.ID, d.State)
	}
	return nil
}

// fill gives a record the empty lists it decodes without, so a caller never
// has to tell a nil slice from an empty one.
func (d *Download) fill() {
	if d.Subtitles == nil {
		d.Subtitles = []DownloadSubtitle{}
	}
	if d.Segments == nil {
		d.Segments = []DownloadSegment{}
	}
	if d.Request.Headers == nil {
		d.Request.Headers = map[string]string{}
	}
}

// compareDownloads orders the device's downloads by creation time, then ID, so
// a list keeps the queue's order and never shuffles between reads.
func compareDownloads(a, b Download) int {
	if c := cmp.Compare(a.CreatedAt, b.CreatedAt); c != 0 {
		return c
	}
	return cmp.Compare(a.ID, b.ID)
}

// Downloads returns every download on this device, oldest first: the queue's
// order, with the done ones among them.
func (s *Store) Downloads() ([]Download, error) {
	return s.downloads(func(Download) bool { return true })
}

// ProfileDownloads returns the downloads profile id started, oldest first.
func (s *Store) ProfileDownloads(id uint64) ([]Download, error) {
	return s.downloads(func(d Download) bool { return d.ProfileID == id })
}

// downloads reads the records keep accepts, oldest first.
func (s *Store) downloads(keep func(Download) bool) ([]Download, error) {
	downloads := []Download{}
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketDownloads)
		if b == nil {
			return nil
		}
		return each(b, func(d Download) {
			if keep(d) {
				downloads = append(downloads, d)
			}
		})
	})
	if err != nil {
		return nil, err
	}
	for i := range downloads {
		downloads[i].fill()
	}
	slices.SortFunc(downloads, compareDownloads)
	return downloads, nil
}

// Download returns the download with this id, or nil for none.
func (s *Store) Download(id string) (*Download, error) {
	var download *Download
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketDownloads)
		if b == nil {
			return nil
		}
		data := b.Get([]byte(id))
		if data == nil {
			return nil
		}
		download = &Download{}
		return decodeOnto(data, download)
	})
	if err != nil || download == nil {
		return nil, err
	}
	download.fill()
	return download, nil
}

// PutDownload inserts or replaces a download, keyed by its ID. A record with
// no ID, profile, video ID or request URL, or a state that isn't one of
// DownloadStates, is refused.
func (s *Store) PutDownload(d Download) error {
	if err := d.validate(); err != nil {
		return err
	}
	d.fill()
	return s.db.Update(func(tx *bolt.Tx) error {
		b, err := tx.CreateBucketIfNotExists(bucketDownloads)
		if err != nil {
			return err
		}
		return put(b, []byte(d.ID), d)
	})
}

// UpdateDownload runs fn on the stored download and writes what it leaves,
// validated as PutDownload does, or ErrDownloadNotFound. Errors from fn leave
// the record as it was.
func (s *Store) UpdateDownload(id string, fn func(*Download) error) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketDownloads)
		if b == nil {
			return fmt.Errorf("%w: %s", ErrDownloadNotFound, id)
		}
		data := b.Get([]byte(id))
		if data == nil {
			return fmt.Errorf("%w: %s", ErrDownloadNotFound, id)
		}
		d := Download{}
		if err := decodeOnto(data, &d); err != nil {
			return err
		}
		if err := fn(&d); err != nil {
			return err
		}
		// The record's key is the id it was written under: a change of id
		// would leave a second record behind.
		if d.ID != id {
			return fmt.Errorf("%w: download %s can't become %q", ErrInvalidItem, id, d.ID)
		}
		if err := d.validate(); err != nil {
			return err
		}
		d.fill()
		return put(b, []byte(id), d)
	})
}

// SetDownloadProgress records how many bytes of a download are on disk and how
// many there will be, Total being 0 until it's known. The downloader writes it
// every couple of seconds while a job runs.
func (s *Store) SetDownloadProgress(id string, bytes, total int64) error {
	return s.UpdateDownload(id, func(d *Download) error {
		d.Bytes, d.Total, d.UpdatedAt = bytes, total, time.Now().UnixMilli()
		return nil
	})
}

// DeleteDownload removes a download and its record. A missing id is not an
// error: deleting what isn't there is what was wanted.
func (s *Store) DeleteDownload(id string) error {
	return s.db.Update(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketDownloads)
		if b == nil {
			return nil
		}
		return b.Delete([]byte(id))
	})
}

// DownloadedBytes is how many bytes the device's downloads take, every state
// counted: a paused or failed download's partial file goes towards the cap
// just as a done one's does.
func (s *Store) DownloadedBytes() (int64, error) {
	var total int64
	err := s.db.View(func(tx *bolt.Tx) error {
		b := tx.Bucket(bucketDownloads)
		if b == nil {
			return nil
		}
		return each(b, func(d Download) { total += d.Bytes })
	})
	return total, err
}
