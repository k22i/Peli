package store

import (
	"errors"
	"fmt"
	"testing"
)

// downloadID is a download's id: 32 hex characters, as the downloader makes
// them.
func downloadID(n int) string { return fmt.Sprintf("%032x", n) }

// aDownload is a film's download, queued: what's saved when a job is added,
// with the lists a caller leaves nil.
func aDownload(id string, profileID uint64, createdAt int64) Download {
	return Download{
		ID: id, ProfileID: profileID,
		ContentID: "tt1160419", ContentType: "movie", VideoID: "tt1160419",
		Name: "Dune", Poster: "https://img/dune.jpg", MetaAddon: cinemeta.URL,
		StreamSource: "https://torrentio.strem.fun/manifest.json", StreamName: "Dune 2021 2160p",
		StreamDescription: "BluRay · 60 GB", Resolution: "2160p",
		Request: DownloadRequest{URL: "https://cdn/dune", Headers: map[string]string{"User-Agent": "Peli"}},
		Root:    "/Users/kevin/Library/Application Support/Peli/Downloads", File: id + "/video.mkv",
		MimeType: "video/x-matroska",
		State:    "queued", CreatedAt: createdAt, UpdatedAt: createdAt, Total: 60_000,
	}
}

// anEpisodeDownload is an episode's, with the subtitles and markers a job
// saves beside the file, done.
func anEpisodeDownload(id string, profileID uint64, createdAt int64) Download {
	return Download{
		ID: id, ProfileID: profileID,
		ContentID: "tt11280740", ContentType: "series", VideoID: "tt11280740:1:2", Season: 1, Episode: 2,
		Name: "Severance", EpisodeName: "Half Loop", Poster: "https://img/severance.jpg",
		MetaAddon: cinemeta.URL, StreamSource: "plugin:torbox", StreamName: "1080p", Resolution: "1080p",
		Request: DownloadRequest{URL: "https://cdn/severance", Headers: map[string]string{}},
		Root:    "", File: id + "/video.mkv", MimeType: "video/x-matroska",
		Subtitles: []DownloadSubtitle{{URL: "https://subs/2.en.srt", Lang: "en", Title: "English", File: id + "/subs/0.srt"}},
		Segments:  []DownloadSegment{{Kind: "intro", Start: 0, End: 92.5}},
		State:     "done", Bytes: 60_000, Total: 60_000, CreatedAt: createdAt, UpdatedAt: createdAt + 500,
		DoneAt: createdAt + 500,
	}
}

// fillLists is a download as the store reads it back: its lists never nil.
func fillLists(d Download) Download {
	if d.Subtitles == nil {
		d.Subtitles = []DownloadSubtitle{}
	}
	if d.Segments == nil {
		d.Segments = []DownloadSegment{}
	}
	if d.Request.Headers == nil {
		d.Request.Headers = map[string]string{}
	}
	return d
}

// A download is put, read back as it went in, and listed only for the profile
// that started it (#85, ADR-0064).
func TestDownloadsPerProfile(t *testing.T) {
	s, _ := openTemp(t)
	anna := must[Profile](t)(s.CreateProfile(Profile{Name: "Anna"}))
	ben := must[Profile](t)(s.CreateProfile(Profile{Name: "Ben"}))

	dune := aDownload(downloadID(1), anna.ID, 2000)
	episode := anEpisodeDownload(downloadID(3), anna.ID, 3000)
	benFilm := aDownload(downloadID(2), ben.ID, 2500)
	for _, d := range []Download{episode, dune, benFilm} {
		check(t, s.PutDownload(d))
	}

	want := fillLists(dune)
	equal(t, must[*Download](t)(s.Download(dune.ID)), &want)
	equal(t, must[*Download](t)(s.Download(episode.ID)), &episode)

	// Everyone's, oldest first, and each profile's own.
	equal(t, must[[]Download](t)(s.Downloads()), []Download{fillLists(dune), fillLists(benFilm), episode})
	equal(t, must[[]Download](t)(s.ProfileDownloads(anna.ID)), []Download{fillLists(dune), episode})
	equal(t, must[[]Download](t)(s.ProfileDownloads(ben.ID)), []Download{fillLists(benFilm)})

	// A profile nobody downloaded for, and an id nothing answers to.
	guest := must[Profile](t)(s.CreateProfile(Profile{Name: "Guest"}))
	equal(t, must[[]Download](t)(s.ProfileDownloads(guest.ID)), []Download{})
	download, err := s.Download(downloadID(99))
	if err != nil || download != nil {
		t.Fatalf("missing download = %+v, %v", download, err)
	}
}

// The lists a caller leaves nil read back empty, not nil: a download with no
// subtitles has none rather than an unknown number of them.
func TestDownloadNilLists(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	d := aDownload(downloadID(1), p.ID, 1000)
	check(t, s.PutDownload(d))

	got := must[*Download](t)(s.Download(d.ID))
	if got.Subtitles == nil || got.Segments == nil || got.Request.Headers == nil {
		t.Fatalf("lists = %v %v %v, want empty", got.Subtitles, got.Segments, got.Request.Headers)
	}
	if len(got.Subtitles) != 0 || len(got.Segments) != 0 || len(got.Request.Headers) != 0 {
		t.Fatalf("lists = %v %v %v, want none", got.Subtitles, got.Segments, got.Request.Headers)
	}
	if list := must[[]Download](t)(s.Downloads()); list[0].Subtitles == nil || list[0].Segments == nil {
		t.Fatalf("listed lists = %v %v, want empty", list[0].Subtitles, list[0].Segments)
	}
}

// Ordering is creation time, then ID: the queue's order, the same on every
// read, whatever order the records were written in.
func TestDownloadsOrder(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))

	// Two share a creation time, so their IDs decide; one comes before both.
	second, third, first := downloadID(2), downloadID(3), downloadID(1)
	for _, d := range []Download{
		aDownload(third, p.ID, 500),
		aDownload(first, p.ID, 400),
		aDownload(second, p.ID, 500),
	} {
		check(t, s.PutDownload(d))
	}
	got := must[[]Download](t)(s.Downloads())
	var ids []string
	for _, d := range got {
		ids = append(ids, d.ID)
	}
	equal(t, ids, []string{first, second, third})
}

// UpdateDownload reads, changes and writes one record; a missing id, an error
// from fn and a record fn leaves invalid all leave the store as it was.
func TestUpdateDownload(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	d := aDownload(downloadID(1), p.ID, 1000)
	check(t, s.PutDownload(d))

	check(t, s.UpdateDownload(d.ID, func(v *Download) error {
		v.State, v.Reason, v.UpdatedAt = "paused", "the user paused it", 1500
		return nil
	}))
	got := must[*Download](t)(s.Download(d.ID))
	if got.State != "paused" || got.Reason != "the user paused it" || got.UpdatedAt != 1500 {
		t.Fatalf("updated = %+v", got)
	}
	// What fn didn't touch is where it was.
	if got.Name != d.Name || got.File != d.File || got.CreatedAt != d.CreatedAt {
		t.Fatalf("updated lost fields: %+v", got)
	}

	if err := s.UpdateDownload(downloadID(99), func(*Download) error { return nil }); !errors.Is(err, ErrDownloadNotFound) {
		t.Fatalf("missing id err = %v, want ErrDownloadNotFound", err)
	}
	if err := s.UpdateDownload(d.ID, func(*Download) error { return errors.New("no") }); err == nil {
		t.Fatal("fn's error was dropped")
	}
	if err := s.UpdateDownload(d.ID, func(v *Download) error { v.State = "sleeping"; return nil }); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("invalid state err = %v, want ErrInvalidItem", err)
	}
	if err := s.UpdateDownload(d.ID, func(v *Download) error { v.ID = downloadID(7); return nil }); !errors.Is(err, ErrInvalidItem) {
		t.Fatalf("changed id err = %v, want ErrInvalidItem", err)
	}
	equal(t, must[*Download](t)(s.Download(d.ID)), got)
}

// Progress is bytes, total and when it was written: the downloader's write
// while a job runs.
func TestSetDownloadProgress(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	d := aDownload(downloadID(1), p.ID, 1000)
	check(t, s.PutDownload(d))

	check(t, s.SetDownloadProgress(d.ID, 12_000, 60_000))
	got := must[*Download](t)(s.Download(d.ID))
	if got.Bytes != 12_000 || got.Total != 60_000 {
		t.Fatalf("progress = %d of %d", got.Bytes, got.Total)
	}
	if got.UpdatedAt <= d.UpdatedAt {
		t.Fatalf("updatedAt = %d, want after %d", got.UpdatedAt, d.UpdatedAt)
	}
	// A resume carries on from the bytes it reached.
	check(t, s.SetDownloadProgress(d.ID, 24_000, 60_000))
	equal(t, must[*Download](t)(s.Download(d.ID)).Bytes, int64(24_000))

	if err := s.SetDownloadProgress(downloadID(99), 1, 2); !errors.Is(err, ErrDownloadNotFound) {
		t.Fatalf("missing id err = %v, want ErrDownloadNotFound", err)
	}
}

// Deleting a download removes its record; deleting what isn't there is what
// was wanted, so it isn't an error.
func TestDeleteDownload(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	d := aDownload(downloadID(1), p.ID, 1000)
	check(t, s.PutDownload(d))

	check(t, s.DeleteDownload(d.ID))
	download, err := s.Download(d.ID)
	if err != nil || download != nil {
		t.Fatalf("deleted download = %+v, %v", download, err)
	}
	equal(t, must[[]Download](t)(s.Downloads()), []Download{})
	check(t, s.DeleteDownload(d.ID))
	check(t, s.DeleteDownload(downloadID(99)))
}

// The device's usage is every download's bytes, whatever its state: a partial
// file counts as much as a whole one.
func TestDownloadedBytes(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	equal(t, must[int64](t)(s.DownloadedBytes()), int64(0))

	var want int64
	for i, state := range DownloadStates {
		d := aDownload(downloadID(i+1), p.ID, int64(1000+i))
		d.State, d.Bytes = state, int64(1000*(i+1))
		check(t, s.PutDownload(d))
		want += d.Bytes
	}
	equal(t, must[int64](t)(s.DownloadedBytes()), want)

	// Deleting one takes its bytes with it.
	check(t, s.DeleteDownload(downloadID(1)))
	equal(t, must[int64](t)(s.DownloadedBytes()), want-1000)
}

// A record that can't be a download is refused: it needs an id, a profile, a
// video, a request and a state the downloader knows.
func TestDownloadValidation(t *testing.T) {
	s, _ := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	good := aDownload(downloadID(1), p.ID, 1000)

	for name, broken := range map[string]func(*Download){
		"no ID":          func(d *Download) { d.ID = "" },
		"no profile":     func(d *Download) { d.ProfileID = 0 },
		"no video ID":    func(d *Download) { d.VideoID = "" },
		"no request URL": func(d *Download) { d.Request.URL = "" },
		"unknown state":  func(d *Download) { d.State = "sleeping" },
	} {
		d := good
		broken(&d)
		if err := s.PutDownload(d); !errors.Is(err, ErrInvalidItem) {
			t.Errorf("%s: err = %v, want ErrInvalidItem", name, err)
		}
	}
	// None of them was written.
	equal(t, must[[]Download](t)(s.Downloads()), []Download{})
}

// Downloads are the device's, so they outlive a relaunch: the queue is the
// store's records, which is how a job that was downloading restarts.
func TestDownloadsSurviveReopen(t *testing.T) {
	s, path := openTemp(t)
	p := must[Profile](t)(s.CreateProfile(Profile{Name: "P"}))
	episode := anEpisodeDownload(downloadID(3), p.ID, 3000)
	dune := aDownload(downloadID(1), p.ID, 1000)
	check(t, s.PutDownload(episode))
	check(t, s.PutDownload(dune))
	check(t, s.SetDownloadProgress(dune.ID, 30_000, 60_000))
	want := fillLists(dune)
	want.Bytes = 30_000
	check(t, s.Close())

	s, err := Open(path)
	check(t, err)
	defer s.Close()
	equal(t, must[[]Download](t)(s.Downloads()), []Download{want, episode})
	equal(t, must[int64](t)(s.DownloadedBytes()), 90_000)
}
