// Package downloads fetches a film or an episode for offline viewing (#85,
// ADR-0064): Go resolves the stream's addon link, downloads the file into a
// per-device folder with Range resumes, and a finished download plays before
// anything is resolved. Only streams with a link (debrid, direct HTTP) are
// downloaded: there is no torrent code path here.
//
// The queue lives in the store's download records, one job runs at a time,
// and everything that differs per OS (free space, the network, the iOS
// background) is the Platform.
package downloads

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/markers"
	"github.com/k22i/Peli/internal/safego"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
)

// Events the frontend listens to.
const (
	EventChanged  = "downloads:changed"
	EventProgress = "downloads:progress"
	EventRemoved  = "downloads:removed"
)

func init() {
	application.RegisterEvent[store.Download](EventChanged)
	application.RegisterEvent[Progress](EventProgress)
	application.RegisterEvent[Removed](EventRemoved)
}

// Error codes (MarshalError, and a failed download's Reason).
const (
	CodeInvalid      = "invalid"
	CodeNotFound     = "not_found"
	CodeKids         = "kids_profile"
	CodeNotAllowed   = "not_allowed"
	CodeOverCap      = "over_cap"
	CodeNoSpace      = "no_space"
	CodeExpired      = "expired"
	CodeSizeMismatch = "size_mismatch"
	CodeNotVideo     = "not_video"
	CodeCaching      = "caching"
	CodeDenied       = "denied"
	CodeBusy         = "busy"
	CodeFailed       = "failed"
	CodeUnreachable  = "unreachable"
	CodeTimeout      = "timeout"
	CodeUnsupported  = "unsupported"
)

// Wait reasons.
const (
	WaitWiFi      = "wifi"
	WaitOffline   = "offline"
	WaitSuspended = "suspended"
)

// ErrUnsupported is what a Platform returns for what it can't do (iOS has no
// folder to choose).
var ErrUnsupported = errors.New("downloads: not supported on this platform")

// Error is a refusal or a failure with a code.
type Error struct{ Code string }

func (e *Error) Error() string { return "downloads: " + e.Code }

func fail(code string) error { return &Error{Code: code} }

// codeOf names an error for the frontend: ours, the store's, or streams'.
func codeOf(err error) string {
	var e *Error
	switch {
	case errors.As(err, &e):
		return e.Code
	case errors.Is(err, ErrUnsupported):
		return CodeUnsupported
	case errors.Is(err, store.ErrDownloadNotFound), errors.Is(err, store.ErrProfileNotFound):
		return CodeNotFound
	case errors.Is(err, store.ErrInvalidItem), errors.Is(err, store.ErrInvalidSettings), errors.Is(err, streams.ErrInvalidURL):
		return CodeInvalid
	case errors.Is(err, streams.ErrExpired):
		return CodeExpired
	case errors.Is(err, streams.ErrBusy):
		return CodeBusy
	case errors.Is(err, streams.ErrNotVideo):
		return CodeNotVideo
	case errors.Is(err, streams.ErrCaching):
		return CodeCaching
	case errors.Is(err, streams.ErrDenied):
		return CodeDenied
	case errors.Is(err, streams.ErrTimeout):
		return CodeTimeout
	case errors.Is(err, streams.ErrUnreachable), errors.Is(err, streams.ErrRedirects), errors.Is(err, streams.ErrUnavailable):
		return CodeUnreachable
	}
	return CodeFailed
}

// MarshalError gives the frontend a code for each error.
func MarshalError(err error) []byte {
	code := codeOf(err)
	data, _ := json.Marshal(map[string]string{"code": code, "message": "downloads: " + code})
	return data
}

// Config is what the service is built from.
type Config struct {
	Open    func() *store.Store
	Resolve func(ctx context.Context, req streams.Request) (streams.Source, error)
	// Markers asks for a title's skip times; nil for none.
	Markers func(ctx context.Context, t markers.Title) ([]markers.Segment, error)
	// Root is the default root: filepath.Join(filepath.Dir(dbPath), "Downloads").
	Root string
	// Version is sent in the User-Agent, as streams does.
	Version string
	// Platform is what differs per OS; nil is newPlatform(), this build's.
	Platform Platform
}

// Platform is what differs per OS. platform_desktop.go and platform_ios.go
// each define newPlatform().
type Platform interface {
	FreeSpace(dir string) (int64, error) // bytes available to this app
	Prepare(root string) error           // mkdir; iOS also excludes it from backup
	Network() Network
	WatchNetwork(fn func(Network)) // called on every change
	// Background asks for time to keep running in the background; end is
	// called once the jobs stop; expiring is called (once) shortly before the
	// OS takes the time back. Desktop: no-op.
	Background(expiring func()) (end func())
	// WatchLifecycle reports going to the background and becoming active.
	WatchLifecycle(background, active func())
	ChooseFolder() (string, error) // "" when cancelled; iOS: ErrUnsupported
}

// Network is what the device is connected to.
type Network struct {
	Online    bool `json:"online"`
	Expensive bool `json:"expensive"` // cellular or hotspot
}

// AddRequest is what the frontend hands over to download a stream.
type AddRequest struct {
	ProfileID         uint64          `json:"profileId"`
	ContentID         string          `json:"contentId"`
	ContentType       string          `json:"contentType"`
	VideoID           string          `json:"videoId"`
	Season            int             `json:"season"`
	Episode           int             `json:"episode"`
	Name              string          `json:"name"`
	EpisodeName       string          `json:"episodeName"`
	Poster            string          `json:"poster"`
	MetaAddon         string          `json:"metaAddon"`
	StreamSource      string          `json:"streamSource"`
	StreamName        string          `json:"streamName"`
	StreamDescription string          `json:"streamDescription"`
	Resolution        string          `json:"resolution"`
	Request           streams.Request `json:"request"`
	Subtitles         []SubtitleRef   `json:"subtitles"`
}

// SubtitleRef is an addon subtitle to save beside the video.
type SubtitleRef struct {
	URL   string `json:"url"`
	Lang  string `json:"lang"`
	Title string `json:"title"`
}

// Playable is a finished download, as the player loads it.
type Playable struct {
	Download  store.Download    `json:"download"`
	Source    streams.Source    `json:"source"` // URL = absolute file path, Origin = "download:<id>"
	Subtitles []LocalSubtitle   `json:"subtitles"`
	Segments  []markers.Segment `json:"segments"`
}

// LocalSubtitle is a saved subtitle, as a file:// URL.
type LocalSubtitle struct {
	URL   string `json:"url"`
	Lang  string `json:"lang"`
	Title string `json:"title"`
}

// Usage is what the downloads take and what is left.
type Usage struct {
	Used int64  `json:"used"` // DownloadedBytes
	Cap  int64  `json:"cap"`  // downloadsCapGB in bytes
	Free int64  `json:"free"` // FreeSpace of the active root
	Dir  string `json:"dir"`  // the active root, absolute
}

// Progress is a running job's progress, at most every 500 ms.
type Progress struct {
	ID    string `json:"id"`
	Bytes int64  `json:"bytes"`
	Total int64  `json:"total"`
	Rate  int64  `json:"rate"` // bytes per second
}

// Removed lists the downloads that were deleted.
type Removed struct {
	IDs []string `json:"ids"`
}

// Timing, overridden by tests.
const (
	progressEvery = 500 * time.Millisecond
	saveEvery     = 2 * time.Second
	backoffMin    = 15 * time.Second
	backoffMax    = 5 * time.Minute
	stallAfter    = 60 * time.Second
	shutdownWait  = 5 * time.Second
	// What is kept free beyond what a job still has to fetch.
	freeMargin = 1 << 30
)

var (
	hexID = regexp.MustCompile(`^[0-9a-f]{32}$`)
	imdb  = regexp.MustCompile(`^tt\d+$`)
)

// Why a running job was stopped, as the context's cause.
var (
	errPause      = errors.New("downloads: paused")
	errDelete     = errors.New("downloads: deleted")
	errCheckpoint = errors.New("downloads: checkpoint")
	errSuspend    = errors.New("downloads: suspended")
)

// job is the one running download.
type job struct {
	ctx    context.Context
	id     string
	cancel context.CancelCauseFunc
	done   chan struct{}
}

// Service is the Wails service for downloads.
type Service struct {
	cfg      Config
	platform Platform
	emit     func(name string, data any)
	httpc    *http.Client

	// Overridable by tests.
	isIOS                       bool
	progressEvery, saveEvery    time.Duration
	backoffMin, backoffMax      time.Duration
	stall                       time.Duration
	shutdownWait                time.Duration
	subtitleTimeout, markerWait time.Duration

	// opMu serialises what changes the queue: picking the next job, and the
	// user's Add, Pause, Resume and Delete. It's held while a stopped job
	// is waited for, so nothing else in the job takes it.
	opMu sync.Mutex

	mu          sync.Mutex
	cur         *job
	suspended   bool   // iOS: the background time is gone, start nothing
	bgEnd       func() // iOS: gives the background time back
	lastCreated int64
	cancelLoop  context.CancelFunc
	loopDone    chan struct{}

	wake    chan struct{} // the queue has changed
	netWake chan struct{} // the network has changed
}

// NewService returns a Service. It does nothing until it starts.
func NewService(cfg Config) *Service {
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 30 * time.Second
	return &Service{
		cfg:  cfg,
		emit: func(string, any) {},
		// No overall timeout: a film takes as long as it takes. A stalled
		// body is cut by the job's own watchdog.
		httpc:           &http.Client{Transport: transport},
		isIOS:           runtime.GOOS == "ios",
		progressEvery:   progressEvery,
		saveEvery:       saveEvery,
		backoffMin:      backoffMin,
		backoffMax:      backoffMax,
		stall:           stallAfter,
		shutdownWait:    shutdownWait,
		subtitleTimeout: 15 * time.Second,
		markerWait:      15 * time.Second,
		wake:            make(chan struct{}, 1),
		netWake:         make(chan struct{}, 1),
	}
}

// ServiceStartup has the service send its events, recovers the queue and
// starts it.
func (s *Service) ServiceStartup(context.Context, application.ServiceOptions) error {
	if app := application.Get(); app != nil {
		s.emit = func(name string, data any) { app.Event.Emit(name, data) }
	}
	s.platform = s.cfg.Platform
	if s.platform == nil {
		s.platform = newPlatform()
	}
	if st := s.cfg.Open(); st != nil {
		s.recover(st)
	}
	s.platform.WatchNetwork(func(Network) { kick(s.netWake) })
	s.platform.WatchLifecycle(s.background, s.active)

	ctx, cancel := context.WithCancel(context.Background())
	s.mu.Lock()
	s.cancelLoop = cancel
	s.loopDone = make(chan struct{})
	done := s.loopDone
	s.mu.Unlock()
	safego.Go("downloads-queue", func() {
		defer close(done)
		s.loop(ctx)
	})
	kick(s.wake)
	return nil
}

// ServiceShutdown checkpoints the running job (its part file and progress
// are flushed, and it is queued again) and waits for it, within 5 s.
func (s *Service) ServiceShutdown() error {
	s.mu.Lock()
	cancel, loopDone, end := s.cancelLoop, s.loopDone, s.bgEnd
	s.bgEnd = nil
	s.mu.Unlock()
	if cancel == nil {
		return nil
	}
	finished := make(chan struct{})
	safego.Go("downloads-shutdown", func() {
		defer close(finished)
		// Stop picking, checkpoint the running job, then end the loop.
		s.opMu.Lock()
		s.mu.Lock()
		s.suspended = true
		s.mu.Unlock()
		if id, ok := s.halt("", errCheckpoint); ok {
			if st, err := s.store(); err == nil {
				s.restate(st, id, "queued", "")
			}
		}
		s.opMu.Unlock()
		cancel()
		<-loopDone
	})
	select {
	case <-finished:
	case <-time.After(s.shutdownWait):
		slog.Warn("downloads: a job didn't stop in time")
	}
	if end != nil {
		end()
	}
	return nil
}

func kick(c chan struct{}) {
	select {
	case c <- struct{}{}:
	default:
	}
}

func (s *Service) store() (*store.Store, error) {
	if s.cfg.Open == nil {
		return nil, fail(CodeFailed)
	}
	st := s.cfg.Open()
	if st == nil {
		return nil, fail(CodeFailed)
	}
	return st, nil
}

// emitChanged sends the record's current state.
func (s *Service) emitChanged(st *store.Store, id string) {
	if d, err := st.Download(id); err == nil && d != nil {
		s.emit(EventChanged, *d)
	}
}

// update edits a record, tells the frontend, and ignores a record deleted
// meanwhile.
func (s *Service) update(st *store.Store, id string, fn func(*store.Download)) {
	err := st.UpdateDownload(id, func(d *store.Download) error {
		fn(d)
		d.UpdatedAt = time.Now().UnixMilli()
		return nil
	})
	if err != nil {
		if !errors.Is(err, store.ErrDownloadNotFound) {
			slog.Warn("downloads: update", "err", err)
		}
		return
	}
	s.emitChanged(st, id)
}

func (s *Service) setState(st *store.Store, id, state, reason string) {
	s.update(st, id, func(d *store.Download) { d.State, d.Reason = state, reason })
}

// rootOf is where a download's folder is: its own root, or the default.
func (s *Service) rootOf(d store.Download) string {
	if d.Root != "" {
		return d.Root
	}
	return s.cfg.Root
}

// activeRoot is where new downloads go.
func (s *Service) activeRoot(st *store.Store) string {
	if settings, err := st.DeviceSettings(); err == nil && settings.DownloadsDir != "" {
		return settings.DownloadsDir
	}
	return s.cfg.Root
}

// removeFiles deletes a download's folder, if its id is one of ours.
func (s *Service) removeFiles(d store.Download) {
	root := s.rootOf(d)
	if root == "" || !hexID.MatchString(d.ID) {
		return
	}
	if err := os.RemoveAll(filepath.Join(root, d.ID)); err != nil {
		slog.Warn("downloads: removing files", "err", err)
	}
}

// viewer is who asks: everything is visible to a grown-up's profile, and to
// a kids profile only what its allowed addons served.
type viewer struct {
	profile store.Profile
	addons  map[string]bool
}

func (s *Service) viewer(st *store.Store, profileID uint64) (viewer, error) {
	profile, err := st.Profile(profileID)
	if err != nil {
		return viewer{}, fail(codeOf(err))
	}
	v := viewer{profile: profile}
	if profile.Kids {
		visible, err := st.VisibleAddons(profileID)
		if err != nil {
			return viewer{}, err
		}
		v.addons = map[string]bool{}
		for _, a := range visible {
			v.addons[a.URL] = true
		}
	}
	return v, nil
}

func (v viewer) sees(d store.Download) bool {
	if d.ProfileID != v.profile.ID {
		return false
	}
	return !v.profile.Kids || v.addons[d.MetaAddon]
}

// own returns the download the profile may see, or not_found.
func (s *Service) own(st *store.Store, profileID uint64, id string) (store.Download, error) {
	v, err := s.viewer(st, profileID)
	if err != nil {
		return store.Download{}, err
	}
	d, err := st.Download(id)
	if err != nil {
		return store.Download{}, err
	}
	if d == nil || !v.sees(*d) {
		return store.Download{}, fail(CodeNotFound)
	}
	return *d, nil
}

func newID() (string, error) {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		return "", err
	}
	return hex.EncodeToString(b), nil
}

func httpURL(raw string) bool {
	u, err := url.Parse(raw)
	return err == nil && (u.Scheme == "http" || u.Scheme == "https") && u.Host != ""
}

// Add queues a download of a stream. It's idempotent per (profile, videoId):
// the existing download is returned, unless it failed, which a new one
// replaces.
func (s *Service) Add(req AddRequest) (store.Download, error) {
	st, err := s.store()
	if err != nil {
		return store.Download{}, err
	}
	if req.ProfileID == 0 || req.ContentID == "" || req.VideoID == "" || !httpURL(req.Request.URL) {
		return store.Download{}, fail(CodeInvalid)
	}
	v, err := s.viewer(st, req.ProfileID)
	if err != nil {
		return store.Download{}, err
	}
	if v.profile.Kids && !v.addons[req.MetaAddon] {
		return store.Download{}, fail(CodeNotAllowed)
	}
	settings, err := st.DeviceSettings()
	if err != nil {
		return store.Download{}, err
	}

	s.opMu.Lock()
	defer s.opMu.Unlock()
	existing, err := st.ProfileDownloads(req.ProfileID)
	if err != nil {
		return store.Download{}, err
	}
	for _, d := range existing {
		if d.VideoID != req.VideoID {
			continue
		}
		if d.State != "failed" {
			return d, nil
		}
		s.removeFiles(d)
		if err := st.DeleteDownload(d.ID); err != nil {
			return store.Download{}, err
		}
		s.emit(EventRemoved, Removed{IDs: []string{d.ID}})
	}

	id, err := newID()
	if err != nil {
		return store.Download{}, err
	}
	subtitles := []store.DownloadSubtitle{}
	for _, ref := range req.Subtitles {
		if httpURL(ref.URL) && len(subtitles) < 10 {
			subtitles = append(subtitles, store.DownloadSubtitle{URL: ref.URL, Lang: ref.Lang, Title: ref.Title})
		}
	}
	s.mu.Lock()
	now := max(time.Now().UnixMilli(), s.lastCreated+1)
	s.lastCreated = now
	s.mu.Unlock()
	d := store.Download{
		ID: id, ProfileID: req.ProfileID,
		ContentID: req.ContentID, ContentType: req.ContentType, VideoID: req.VideoID,
		Season: req.Season, Episode: req.Episode, Name: req.Name, EpisodeName: req.EpisodeName,
		Poster: req.Poster, MetaAddon: req.MetaAddon,
		StreamSource: req.StreamSource, StreamName: req.StreamName,
		StreamDescription: req.StreamDescription, Resolution: req.Resolution,
		Request: store.DownloadRequest{URL: req.Request.URL, Headers: req.Request.Headers},
		// A change of folder applies to new jobs: this one keeps its root.
		Root:      settings.DownloadsDir,
		Subtitles: subtitles, Segments: []store.DownloadSegment{},
		State: "queued", CreatedAt: now, UpdatedAt: now,
	}
	if err := st.PutDownload(d); err != nil {
		return store.Download{}, fail(codeOf(err))
	}
	stored, err := st.Download(id)
	if err != nil || stored == nil {
		return d, err
	}
	s.emit(EventChanged, *stored)
	kick(s.wake)
	return *stored, nil
}

// List returns the profile's downloads, the queue's order, hiding from a
// kids profile what its addons didn't serve.
func (s *Service) List(profileID uint64) ([]store.Download, error) {
	st, err := s.store()
	if err != nil {
		return nil, err
	}
	v, err := s.viewer(st, profileID)
	if err != nil {
		return nil, err
	}
	all, err := st.ProfileDownloads(profileID)
	if err != nil {
		return nil, err
	}
	return slices.DeleteFunc(all, func(d store.Download) bool { return !v.sees(d) }), nil
}

// Get returns one of the profile's downloads.
func (s *Service) Get(profileID uint64, id string) (*store.Download, error) {
	st, err := s.store()
	if err != nil {
		return nil, err
	}
	d, err := s.own(st, profileID, id)
	if err != nil {
		return nil, err
	}
	return &d, nil
}

// Pause stops a download, keeping its part file.
func (s *Service) Pause(profileID uint64, id string) error {
	st, err := s.store()
	if err != nil {
		return err
	}
	if _, err := s.own(st, profileID, id); err != nil {
		return err
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.halt(id, errPause)
	d, err := st.Download(id)
	if err != nil || d == nil {
		return err
	}
	if slices.Contains([]string{"queued", "downloading", "waiting"}, d.State) {
		s.setState(st, id, "paused", "")
	}
	return nil
}

// Resume queues a paused, waiting or failed download again.
func (s *Service) Resume(profileID uint64, id string) error {
	st, err := s.store()
	if err != nil {
		return err
	}
	if _, err := s.own(st, profileID, id); err != nil {
		return err
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	// A job waiting for the network tries again now.
	s.halt(id, errPause)
	d, err := st.Download(id)
	if err != nil || d == nil {
		return err
	}
	if slices.Contains([]string{"paused", "waiting", "failed", "downloading"}, d.State) {
		s.setState(st, id, "queued", "")
		kick(s.wake)
	}
	return nil
}

// Delete stops the downloads, and removes their files and records.
func (s *Service) Delete(profileID uint64, ids []string) error {
	st, err := s.store()
	if err != nil {
		return err
	}
	var found []store.Download
	for _, id := range ids {
		d, err := s.own(st, profileID, id)
		if err != nil {
			return err
		}
		found = append(found, d)
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	s.remove(st, found)
	return nil
}

// DeleteAll removes every download on the device.
func (s *Service) DeleteAll(profileID uint64) error {
	st, err := s.store()
	if err != nil {
		return err
	}
	v, err := s.viewer(st, profileID)
	if err != nil {
		return err
	}
	if v.profile.Kids {
		return fail(CodeKids)
	}
	s.opMu.Lock()
	defer s.opMu.Unlock()
	all, err := st.Downloads()
	if err != nil {
		return err
	}
	s.remove(st, all)
	return nil
}

// remove deletes downloads, with opMu held.
func (s *Service) remove(st *store.Store, list []store.Download) {
	if len(list) == 0 {
		return
	}
	ids := make([]string, 0, len(list))
	for _, d := range list {
		s.halt(d.ID, errDelete)
		s.removeFiles(d)
		if err := st.DeleteDownload(d.ID); err != nil {
			slog.Warn("downloads: deleting", "err", err)
			continue
		}
		ids = append(ids, d.ID)
	}
	s.emit(EventRemoved, Removed{IDs: ids})
}

// Playable returns the finished download of a video, with its files, or nil.
func (s *Service) Playable(profileID uint64, videoID string) (*Playable, error) {
	st, err := s.store()
	if err != nil {
		return nil, err
	}
	v, err := s.viewer(st, profileID)
	if err != nil {
		return nil, err
	}
	all, err := st.ProfileDownloads(profileID)
	if err != nil {
		return nil, err
	}
	for _, d := range slices.Backward(all) {
		if d.VideoID != videoID || d.State != "done" || !v.sees(d) {
			continue
		}
		root := s.rootOf(d)
		file, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(d.File)))
		if err != nil {
			continue
		}
		info, err := os.Stat(file)
		if err != nil || info.IsDir() {
			continue
		}
		p := &Playable{
			Download: d,
			Source: streams.Source{
				URL: file, Origin: "download:" + d.ID, Headers: map[string]string{},
				ContentType: d.MimeType, Size: info.Size(),
			},
			Subtitles: []LocalSubtitle{},
			Segments:  []markers.Segment{},
		}
		for _, sub := range d.Subtitles {
			if sub.File == "" {
				continue
			}
			path, err := filepath.Abs(filepath.Join(root, filepath.FromSlash(sub.File)))
			if err != nil {
				continue
			}
			if _, err := os.Stat(path); err != nil {
				continue
			}
			p.Subtitles = append(p.Subtitles, LocalSubtitle{URL: fileURL(path), Lang: sub.Lang, Title: sub.Title})
		}
		for _, seg := range d.Segments {
			p.Segments = append(p.Segments, markers.Segment{Kind: seg.Kind, Start: seg.Start, End: seg.End})
		}
		return p, nil
	}
	return nil, nil
}

// fileURL is a file:// URL for an absolute path.
func fileURL(path string) string {
	p := filepath.ToSlash(path)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p // C:/… on Windows
	}
	return (&url.URL{Scheme: "file", Path: p}).String()
}

// Usage says what the downloads take and what is left.
func (s *Service) Usage() (Usage, error) {
	st, err := s.store()
	if err != nil {
		return Usage{}, err
	}
	used, err := st.DownloadedBytes()
	if err != nil {
		return Usage{}, err
	}
	settings, err := st.DeviceSettings()
	if err != nil {
		return Usage{}, err
	}
	root := s.activeRoot(st)
	u := Usage{Used: used, Cap: int64(settings.DownloadsCapGB) << 30, Dir: root}
	if p := s.platform; p != nil {
		free, err := p.FreeSpace(root)
		if err != nil && p.Prepare(root) == nil {
			free, err = p.FreeSpace(root)
		}
		if err == nil {
			u.Free = free
		}
	}
	return u, nil
}

// ChooseFolder asks for the folder new downloads go to and saves it; "" is
// cancelled.
func (s *Service) ChooseFolder(profileID uint64) (string, error) {
	st, err := s.store()
	if err != nil {
		return "", err
	}
	v, err := s.viewer(st, profileID)
	if err != nil {
		return "", err
	}
	if v.profile.Kids {
		return "", fail(CodeKids)
	}
	if s.platform == nil {
		return "", ErrUnsupported
	}
	dir, err := s.platform.ChooseFolder()
	if err != nil || dir == "" {
		return "", err
	}
	settings, err := st.DeviceSettings()
	if err != nil {
		return "", err
	}
	settings.DownloadsDir = dir
	if err := st.SaveDeviceSettings(settings); err != nil {
		return "", err
	}
	return dir, nil
}

// Network is what the device is connected to.
func (s *Service) Network() Network {
	if s.platform == nil {
		return Network{Online: true}
	}
	return s.platform.Network()
}
