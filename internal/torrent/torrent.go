// Package torrent streams a torrent's video peer to peer (#55): an embedded
// anacrolix/torrent client fetches the pieces around what the player reads
// first, and a loopback HTTP server hands the file to mpv as if it were any
// other link, ranges and all. Pieces go to a disk cache with a cap (cache.go).
// It is off unless the user turns it on, since peers see the user's IP
// address and get pieces from them while they watch. See ADR-0040.
//
// One torrent plays at a time. The client starts with the first one and
// stops a while after the last one is let go, so it costs nothing until
// it's used.
package torrent

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"mime"
	"net"
	"net/http"
	"net/url"
	"os"
	"path"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/adrg/xdg"
	alog "github.com/anacrolix/log"
	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/metainfo"
	"github.com/anacrolix/torrent/types/infohash"

	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
)

var (
	// ErrDisabled means torrent streaming is off in Settings.
	ErrDisabled = errors.New("torrent: streaming torrents is off")
	// ErrInvalid means the request has no valid info hash.
	ErrInvalid = errors.New("torrent: not an info hash")
	// ErrNoPeers means no peer sent the torrent's metadata within
	// MetadataWait: a dead or unreachable swarm.
	ErrNoPeers = errors.New("torrent: no peers")
	// ErrNoFile means the torrent has no video file to play: none at the
	// addon's index or by its name, and no video at all.
	ErrNoFile = errors.New("torrent: no video file")
	// ErrFailed means the engine couldn't start: no port, no disk.
	ErrFailed = errors.New("torrent: engine failed")
)

// Error codes the frontend reads (MarshalError).
const (
	CodeDisabled = "disabled"
	CodeInvalid  = "invalid"
	CodeNoPeers  = "no_peers"
	CodeNoFile   = "no_file"
	CodeFailed   = "failed"
)

const (
	// MetadataWait caps the wait for a torrent's metadata (its file list)
	// from peers. A healthy swarm sends it in a few seconds.
	MetadataWait = 45 * time.Second
	// IdleClose is how long the client stays up once nothing plays, so the
	// next pick skips joining the DHT again.
	IdleClose = 5 * time.Minute
	// readahead is fetched first past what the player reads. mpv reads well
	// ahead of the picture itself, so this needn't be large. It is also all
	// the client asks for at once, so the cache must be larger.
	readahead = 16 << 20
	// refetchWait caps how long a read waits for a piece the cache dropped
	// to come again, before the player gets an error.
	refetchWait = 30 * time.Second
	// aheadMax caps the bytes Status counts as ready.
	aheadMax = 1 << 30
	// keepAlive is how often a connection's writer wakes when idle. In
	// anacrolix/torrent v1.61 the writer can miss the signal to ask a peer
	// for pieces (it comes between its last look and its wait), and then
	// sleeps until this timer: a minute by default, which stalled about 1 in
	// 25 test streams for a minute right after the metadata came. A wake-up
	// costs a 4-byte keep-alive to a peer we want something from.
	keepAlive = 2 * time.Second
	// GB is a gigabyte, as the cache sizes in Settings count them.
	GB = 1_000_000_000
)

// Public trackers asked besides the DHT and the stream's own: Torrentio
// sends no trackers with its streams.
var trackers = []string{
	"udp://tracker.opentrackr.org:1337/announce",
	"udp://open.demonii.com:1337/announce",
	"udp://open.stealth.si:80/announce",
	"udp://tracker.torrent.eu.org:451/announce",
	"udp://exodus.desync.com:6969/announce",
	"udp://explodie.org:6969/announce",
	"udp://tracker.theoks.net:6969/announce",
}

// Request is a torrent stream from an addon: its info hash, the file's
// index in the torrent, its name, and the stream's sources ("tracker:<url>",
// "dht:<hash>").
type Request struct {
	InfoHash string   `json:"infoHash"`
	FileIdx  *int     `json:"fileIdx"`
	FileName string   `json:"fileName"`
	Sources  []string `json:"sources"`
}

// Status is what the player shows while a torrent plays.
type Status struct {
	// A torrent is open.
	Active bool `json:"active"`
	// Its file list has come and the file is chosen.
	Ready bool `json:"ready"`
	// Peers connected, and how many of them have the whole torrent.
	Peers   int `json:"peers"`
	Seeders int `json:"seeders"`
	// Bytes a second, over the last few seconds.
	DownloadRate int64 `json:"downloadRate"`
	UploadRate   int64 `json:"uploadRate"`
	// Bytes ready past where the player reads, and of the whole file.
	Ahead int64 `json:"ahead"`
	Done  int64 `json:"done"`
	Size  int64 `json:"size"`
}

// Settings is where the engine reads the user's consent and cache size:
// the store's device settings.
type Settings interface {
	DeviceSettings() (store.DeviceSettings, error)
}

// Service is the Wails service the frontend calls to stream torrents.
type Service struct {
	settings Settings
	dir      string
	version  string
	// Tests run without the DHT and public trackers, with a shorter wait
	// and peers of their own.
	trackers     []string
	metadataWait time.Duration
	readahead    int64
	configure    func(*torrent.ClientConfig)
	added        func(*torrent.Torrent)

	mu      sync.Mutex
	client  *torrent.Client
	cache   *cache
	server  *http.Server
	base    string // http://127.0.0.1:<port>/<secret>
	secret  string
	current *session
	idle    *time.Timer
}

// session is the torrent playing.
type session struct {
	t *torrent.Torrent
	// The file playing, set before ready closes. Another file of the same
	// torrent (the next episode in a season pack) replaces it.
	file atomic.Pointer[torrent.File]
	// Closed once the first file is chosen.
	ready     chan struct{}
	readyOnce sync.Once
	stop      chan struct{}

	// The player's furthest-reading connection: where it reads, and how
	// much it has read.
	readers sync.Map // *servedReader → struct{}
	down    atomic.Int64
	up      atomic.Int64
}

// DefaultDir is where pieces are cached: the OS's cache folder, or the
// data folder PELI_DATA_DIR names.
func DefaultDir() string {
	if dir := os.Getenv("PELI_DATA_DIR"); dir != "" {
		return filepath.Join(dir, "torrents")
	}
	return filepath.Join(xdg.CacheHome, "Peli", "torrents")
}

// NewService returns a Service caching pieces in dir, reading consent and
// the cache size from settings.
func NewService(settings Settings, dir, version string) *Service {
	return &Service{
		settings:     settings,
		dir:          dir,
		version:      version,
		trackers:     trackers,
		metadataWait: MetadataWait,
		readahead:    readahead,
		configure:    func(*torrent.ClientConfig) {},
		added:        func(*torrent.Torrent) {},
	}
}

// ServiceShutdown stops the client and the server.
func (s *Service) ServiceShutdown() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.closeLocked()
	return nil
}

// Open starts streaming req's torrent and returns the Source the player
// loads: a loopback link to the file. It waits for the torrent's file list
// from peers. Opening another torrent stops the one before, and another
// file of the same torrent (the next episode in a pack) replaces the file
// playing; cancelling the call lets this one go.
func (s *Service) Open(ctx context.Context, req Request) (streams.Source, error) {
	settings, err := s.settings.DeviceSettings()
	if err != nil {
		return streams.Source{}, ErrFailed
	}
	if !settings.TorrentStreaming {
		return streams.Source{}, ErrDisabled
	}
	hash, err := parseHash(req.InfoHash)
	if err != nil {
		return streams.Source{}, ErrInvalid
	}

	s.mu.Lock()
	if err := s.startLocked(int64(settings.TorrentCacheGB) * GB); err != nil {
		s.mu.Unlock()
		return streams.Source{}, ErrFailed
	}
	ses := s.current
	if ses == nil || ses.t.InfoHash() != hash {
		s.releaseLocked()
		ses = s.openLocked(hash, req.Sources)
	}
	base := s.base
	s.mu.Unlock()

	file, err := ses.choose(ctx, req, s.metadataWait)
	if err != nil {
		if ctx.Err() != nil {
			err = context.Canceled
		}
		s.mu.Lock()
		if s.current == ses {
			s.releaseLocked()
		}
		s.mu.Unlock()
		return streams.Source{}, err
	}
	name := path.Base(file.DisplayPath())
	return streams.Source{
		URL: base + "/" + hash.HexString() + "/" + strconv.Itoa(fileIndex(ses.t, file)) +
			"/" + url.PathEscape(name),
		Origin:      "magnet:?xt=urn:btih:" + hash.HexString(),
		Headers:     map[string]string{},
		ContentType: contentType(name),
		Size:        file.Length(),
	}, nil
}

// Release stops the torrent playing, if one is. The client stops IdleClose
// later unless another opens.
func (s *Service) Release() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.releaseLocked()
}

// Status says how the torrent playing is doing.
func (s *Service) Status() Status {
	s.mu.Lock()
	ses := s.current
	s.mu.Unlock()
	if ses == nil {
		return Status{}
	}
	stats := ses.t.Stats()
	status := Status{
		Active:       true,
		Peers:        stats.ActivePeers,
		Seeders:      stats.ConnectedSeeders,
		DownloadRate: ses.down.Load(),
		UploadRate:   ses.up.Load(),
	}
	select {
	case <-ses.ready:
	default:
		return status
	}
	status.Ready = true
	file := ses.file.Load()
	status.Size = file.Length()
	status.Done = file.BytesCompleted()
	status.Ahead = ses.ahead()
	return status
}

// CacheSize is the bytes of torrent pieces kept on disk.
func (s *Service) CacheSize() int64 {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache != nil {
		return s.cache.Size()
	}
	return dirSize(s.dir)
}

// ClearCache deletes the cached pieces, but those of the torrent playing.
func (s *Service) ClearCache() error {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache != nil {
		s.cache.Clear()
		return nil
	}
	if err := os.RemoveAll(s.dir); err != nil && !errors.Is(err, os.ErrNotExist) {
		return ErrFailed
	}
	return nil
}

// SetCacheSize applies a new cap at once; the store keeps it for the next
// start.
func (s *Service) SetCacheSize(gb int) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.cache != nil && gb > 0 {
		s.cache.SetMax(int64(gb) * GB)
	}
}

// startLocked starts the cache, the client and the server, unless they run.
func (s *Service) startLocked(max int64) error {
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
	if s.client != nil {
		s.cache.SetMax(max)
		return nil
	}
	c, err := openCache(s.dir, max)
	if err != nil {
		return err
	}
	cfg := torrent.NewDefaultClientConfig()
	cfg.DefaultStorage = c
	cfg.DataDir = s.dir
	// Any free port: a fixed one clashes with another client.
	cfg.ListenPort = 0
	cfg.DisableWebtorrent = true
	cfg.KeepAliveTimeout = keepAlive
	cfg.HTTPUserAgent = "Peli/" + s.version
	cfg.Slogger = slog.New(slog.DiscardHandler)
	cfg.Logger = alog.Default.WithFilterLevel(alog.Disabled)
	s.configure(cfg)
	client, err := torrent.NewClient(cfg)
	if err != nil {
		return err
	}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		client.Close()
		return err
	}
	secret := make([]byte, 16)
	_, _ = rand.Read(secret)
	c.mu.Lock()
	c.evicted = func(key pieceKey) {
		// Not while the cache is locked: the client calls the cache under
		// its own lock.
		go func() {
			if t, ok := client.Torrent(key.hash); ok && t.Info() != nil && key.index < t.NumPieces() {
				t.Piece(key.index).UpdateCompletion()
			}
		}()
	}
	c.mu.Unlock()
	s.client, s.cache, s.secret = client, c, hex.EncodeToString(secret)
	s.base = "http://" + listener.Addr().String() + "/" + s.secret
	s.server = &http.Server{Handler: s, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = s.server.Serve(listener) }()
	return nil
}

// openLocked adds hash to the client as the session playing.
func (s *Service) openLocked(hash metainfo.Hash, sources []string) *session {
	t, _ := s.client.AddTorrentInfoHash(hash)
	t.AddTrackers([][]string{append(trackersOf(sources), s.trackers...)})
	s.added(t)
	s.cache.Hold(hash)
	ses := &session{t: t, ready: make(chan struct{}), stop: make(chan struct{})}
	s.current = ses
	go ses.measure()
	return ses
}

// releaseLocked drops the session's torrent and sets the client to stop
// once idle.
func (s *Service) releaseLocked() {
	ses := s.current
	if ses == nil {
		return
	}
	s.current = nil
	close(ses.stop)
	ses.t.Drop()
	s.cache.Release(ses.t.InfoHash())
	if s.idle == nil {
		s.idle = time.AfterFunc(IdleClose, func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if s.current == nil {
				s.closeLocked()
			}
		})
	}
}

// closeLocked stops everything.
func (s *Service) closeLocked() {
	s.releaseLocked()
	if s.idle != nil {
		s.idle.Stop()
		s.idle = nil
	}
	if s.server != nil {
		_ = s.server.Close()
		s.server = nil
	}
	if s.client != nil {
		s.client.Close()
		s.client, s.cache = nil, nil
	}
}

// choose waits for the torrent's file list and picks req's file. Once one
// is chosen, another request picks again: the file it names plays from
// then on, and the one before stops serving.
func (ses *session) choose(ctx context.Context, req Request, wait time.Duration) (*torrent.File, error) {
	// Both channels can be ready at once (a second request, once the info is
	// in), so either one takes the same path and ready closes only once.
	pickNow := func() (*torrent.File, error) {
		file, err := pickFile(ses.t, req)
		if err != nil {
			return nil, err
		}
		if file != ses.file.Load() {
			fetchEnds(ses.t, file)
			ses.file.Store(file)
		}
		ses.readyOnce.Do(func() { close(ses.ready) })
		return file, nil
	}
	select {
	case <-ses.ready:
		return pickNow()
	case <-ses.t.GotInfo():
		return pickNow()
	case <-ctx.Done():
		return nil, ctx.Err()
	case <-time.After(wait):
		return nil, ErrNoPeers
	}
}

// pickFile finds req's file in t, which has its info.
func pickFile(t *torrent.Torrent, req Request) (*torrent.File, error) {
	files := t.Files()
	names := make([]fileInfo, len(files))
	for i, f := range files {
		names[i] = fileInfo{f.DisplayPath(), f.Length()}
	}
	i := pick(names, req)
	if i < 0 {
		return nil, ErrNoFile
	}
	return files[i], nil
}

// fetchEnds asks for file's ends first: MP4s often keep their index at the
// end, and MKVs their cues.
func fetchEnds(t *torrent.Torrent, file *torrent.File) {
	first, last := file.BeginPieceIndex(), file.EndPieceIndex()
	t.DownloadPieces(first, min(first+2, last))
	t.DownloadPieces(max(last-2, first), last)
}

// A file in a torrent: its path and size.
type fileInfo struct {
	path   string
	length int64
}

// pick finds the index of the file to play: the addon's index when its
// name agrees, else the file by name, else the largest video; -1 for none.
func pick(files []fileInfo, req Request) int {
	name := strings.ToLower(req.FileName)
	matches := func(f fileInfo) bool {
		return name == "" || strings.ToLower(path.Base(f.path)) == name
	}
	if i := req.FileIdx; i != nil && *i >= 0 && *i < len(files) && matches(files[*i]) &&
		isVideo(files[*i].path) {
		return *i
	}
	if name != "" {
		for i, f := range files {
			if matches(f) && isVideo(f.path) {
				return i
			}
		}
	}
	largest := -1
	for i, f := range files {
		if isVideo(f.path) && (largest < 0 || f.length > files[largest].length) {
			largest = i
		}
	}
	return largest
}

var videoExts = []string{
	".mkv", ".mp4", ".m4v", ".avi", ".mov", ".webm", ".ts", ".m2ts", ".mts", ".wmv",
	".flv", ".mpg", ".mpeg", ".ogv", ".3gp",
}

func isVideo(name string) bool {
	return slices.Contains(videoExts, strings.ToLower(path.Ext(name)))
}

func contentType(name string) string {
	switch ext := strings.ToLower(path.Ext(name)); ext {
	case ".mkv":
		return "video/x-matroska"
	case ".ts", ".m2ts", ".mts":
		return "video/mp2t"
	default:
		if kind := mime.TypeByExtension(ext); strings.HasPrefix(kind, "video/") {
			return kind
		}
		return "application/octet-stream"
	}
}

// trackersOf takes the trackers from a stream's sources.
func trackersOf(sources []string) []string {
	var out []string
	for _, source := range sources {
		if tracker, ok := strings.CutPrefix(source, "tracker:"); ok {
			if u, err := url.Parse(tracker); err == nil &&
				(u.Scheme == "udp" || u.Scheme == "http" || u.Scheme == "https") {
				out = append(out, tracker)
			}
		}
	}
	return out
}

// parseHash reads a v1 info hash: 40 hex digits, as addons send them.
func parseHash(s string) (metainfo.Hash, error) {
	var hash infohash.T
	if len(s) != 40 {
		return hash, ErrInvalid
	}
	return hash, hash.FromHexString(s)
}

func fileIndex(t *torrent.Torrent, f *torrent.File) int {
	return slices.Index(t.Files(), f)
}

// measure samples the transfer rates every second, averaged over three.
func (ses *session) measure() {
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	var downs, ups []int64
	for {
		select {
		case <-ses.stop:
			return
		case <-tick.C:
		}
		stats := ses.t.Stats()
		downs = window(append(downs, stats.BytesReadUsefulData.Int64()))
		ups = window(append(ups, stats.BytesWrittenData.Int64()))
		ses.down.Store(rate(downs))
		ses.up.Store(rate(ups))
	}
}

func window(samples []int64) []int64 {
	if len(samples) > 4 {
		return samples[len(samples)-4:]
	}
	return samples
}

func rate(samples []int64) int64 {
	if len(samples) < 2 {
		return 0
	}
	return (samples[len(samples)-1] - samples[0]) / int64(len(samples)-1)
}

// ahead counts the bytes ready from where the player's main connection
// reads, to the first piece missing.
func (ses *session) ahead() int64 {
	var main *servedReader
	ses.readers.Range(func(key, _ any) bool {
		if r := key.(*servedReader); main == nil || r.read.Load() > main.read.Load() {
			main = r
		}
		return true
	})
	if main == nil {
		return 0
	}
	t, f := ses.t, ses.file.Load()
	info := t.Info()
	if info == nil {
		return 0
	}
	start := f.Offset() + main.pos.Load()
	end := f.Offset() + f.Length()
	at := start
	for i := int(start / info.PieceLength); at < end && at-start < aheadMax; i++ {
		if !t.PieceState(i).Complete {
			break
		}
		at = min(int64(i+1)*info.PieceLength, end)
	}
	return max(at-start, 0)
}

// ServeHTTP serves the file playing at
// /<secret>/<info hash>/<file index>/<name>, with ranges.
func (s *Service) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	parts := strings.SplitN(strings.TrimPrefix(r.URL.Path, "/"), "/", 4)
	s.mu.Lock()
	secret, ses := s.secret, s.current
	s.mu.Unlock()
	if len(parts) < 3 || !sameSecret(parts[0], secret) || ses == nil ||
		parts[1] != ses.t.InfoHash().HexString() || !loopback(r.Host) {
		http.NotFound(w, r)
		return
	}
	select {
	case <-ses.ready:
	default:
		http.NotFound(w, r)
		return
	}
	file := ses.file.Load()
	if parts[2] != strconv.Itoa(fileIndex(ses.t, file)) {
		http.NotFound(w, r)
		return
	}
	reader := file.NewReader()
	defer reader.Close()
	reader.SetResponsive()
	reader.SetReadahead(s.readahead)
	served := &servedReader{r: reader, ctx: r.Context()}
	ses.readers.Store(served, struct{}{})
	defer ses.readers.Delete(served)
	w.Header().Set("Content-Type", contentType(file.DisplayPath()))
	http.ServeContent(w, r, "", time.Time{}, served)
}

// servedReader reads the file for one of the player's connections, keeping
// where it reads for Status.
type servedReader struct {
	r    torrent.Reader
	ctx  context.Context
	pos  atomic.Int64
	read atomic.Int64
}

func (sr *servedReader) Read(b []byte) (int, error) {
	n, err := sr.r.ReadContext(sr.ctx, b)
	// A piece the cache dropped as the reader reached it: the client is told
	// (and the reader tells it too), and fetches it again.
	for give := time.Now().Add(refetchWait); n == 0 && err != nil && err != io.EOF &&
		sr.ctx.Err() == nil && time.Now().Before(give); {
		time.Sleep(100 * time.Millisecond)
		n, err = sr.r.ReadContext(sr.ctx, b)
	}
	sr.pos.Add(int64(n))
	sr.read.Add(int64(n))
	return n, err
}

func (sr *servedReader) Seek(offset int64, whence int) (int64, error) {
	at, err := sr.r.Seek(offset, whence)
	if err == nil {
		sr.pos.Store(at)
	}
	return at, err
}

var _ io.ReadSeeker = (*servedReader)(nil)

func sameSecret(got, want string) bool {
	return want != "" && len(got) == len(want) && subtle.ConstantTimeCompare([]byte(got), []byte(want)) == 1
}

// loopback reports a Host naming this machine, so a web page can't reach
// the server through a name it points at 127.0.0.1.
func loopback(host string) bool {
	h, _, err := net.SplitHostPort(host)
	if err != nil {
		h = host
	}
	ip := net.ParseIP(h)
	return ip != nil && ip.IsLoopback()
}

func dirSize(dir string) int64 {
	var size int64
	_ = filepath.WalkDir(dir, func(_ string, d os.DirEntry, err error) error {
		if err == nil && d.Type().IsRegular() {
			if info, err := d.Info(); err == nil {
				size += info.Size()
			}
		}
		return nil
	})
	return size
}

// MarshalError gives the frontend a code for each error, never its text.
func MarshalError(err error) []byte {
	code := CodeFailed
	for _, known := range []struct {
		err  error
		code string
	}{
		{ErrDisabled, CodeDisabled}, {ErrInvalid, CodeInvalid},
		{ErrNoPeers, CodeNoPeers}, {ErrNoFile, CodeNoFile},
	} {
		if errors.Is(err, known.err) {
			code = known.code
			break
		}
	}
	data, _ := json.Marshal(map[string]string{"code": code})
	return data
}
