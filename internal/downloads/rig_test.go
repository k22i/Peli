package downloads

import (
	"bytes"
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
)

const (
	addonA = "https://a.example/manifest.json"
	addonB = "https://b.example/manifest.json"
)

// payload is a body a few reads long.
var payload = bytes.Repeat([]byte("0123456789abcdef"), 40_000) // 640 000 bytes

// fileServer serves payload with Range support, and misbehaves on demand.
// The hooks take the request's number, counted from 1.
type fileServer struct {
	*httptest.Server
	body        []byte
	ctype       string
	ignoreRange func(hit int) bool
	claimTotal  int64
	status      func(hit int) int       // non-zero: answer with only this status
	cutAfter    func(hit int) int       // >0: abort the connection after this many body bytes
	holdAfter   func(hit int) int       // >0: stop after this many body bytes and wait
	release     chan struct{}
	once        sync.Once

	mu     sync.Mutex
	hits   int
	ranges []string
}

func newFileServer(t *testing.T, tweak func(*fileServer)) *fileServer {
	t.Helper()
	f := &fileServer{body: payload, ctype: "video/mp4", release: make(chan struct{})}
	if tweak != nil {
		tweak(f)
	}
	f.Server = httptest.NewServer(f)
	t.Cleanup(func() {
		f.unhold()
		f.Server.Close()
	})
	return f
}

// unhold lets the held requests go.
func (f *fileServer) unhold() { f.once.Do(func() { close(f.release) }) }

func (f *fileServer) requests() (int, []string) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.hits, append([]string(nil), f.ranges...)
}

func (f *fileServer) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	f.hits++
	hit := f.hits
	f.ranges = append(f.ranges, r.Header.Get("Range"))
	f.mu.Unlock()
	if f.status != nil {
		if code := f.status(hit); code != 0 {
			w.WriteHeader(code)
			return
		}
	}
	n := int64(len(f.body))
	var start int64
	ranged := false
	if h := r.Header.Get("Range"); h != "" && (f.ignoreRange == nil || !f.ignoreRange(hit)) {
		if _, err := fmt.Sscanf(h, "bytes=%d-", &start); err == nil {
			ranged = true
		}
	}
	if ranged && start >= n {
		w.WriteHeader(http.StatusRequestedRangeNotSatisfiable)
		return
	}
	send := f.body[start:]
	total := n
	if f.claimTotal > 0 {
		total = f.claimTotal
	}
	w.Header().Set("Content-Type", f.ctype)
	w.Header().Set("Content-Length", strconv.Itoa(len(send)))
	if ranged {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, n-1, total))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}
	limit := len(send)
	cut, hold := false, false
	if f.cutAfter != nil {
		if c := f.cutAfter(hit); c > 0 && c < limit {
			limit, cut = c, true
		}
	}
	if f.holdAfter != nil {
		if c := f.holdAfter(hit); c > 0 && c < limit {
			limit, hold = c, true
		}
	}
	_, _ = w.Write(send[:limit])
	if fl, ok := w.(http.Flusher); ok {
		fl.Flush()
	}
	if cut {
		panic(http.ErrAbortHandler)
	}
	if hold {
		select {
		case <-r.Context().Done():
		case <-f.release:
		}
	}
}

// fakePlatform is the OS, as the tests set it.
type fakePlatform struct {
	mu       sync.Mutex
	free     int64
	net      Network
	netFn    func(Network)
	bgFn     func()
	actFn    func()
	expiring func()
	bgCalls  int
	ended    int
	folder   string
}

func (p *fakePlatform) FreeSpace(string) (int64, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.free, nil
}
func (p *fakePlatform) Prepare(root string) error { return os.MkdirAll(root, 0o700) }
func (p *fakePlatform) Network() Network {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.net
}
func (p *fakePlatform) WatchNetwork(fn func(Network)) {
	p.mu.Lock()
	p.netFn = fn
	p.mu.Unlock()
}
func (p *fakePlatform) Background(expiring func()) func() {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.bgCalls++
	p.expiring = expiring
	return func() {
		p.mu.Lock()
		p.ended++
		p.mu.Unlock()
	}
}
func (p *fakePlatform) WatchLifecycle(background, active func()) {
	p.mu.Lock()
	p.bgFn, p.actFn = background, active
	p.mu.Unlock()
}
func (p *fakePlatform) ChooseFolder() (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.folder, nil
}

func (p *fakePlatform) setNet(n Network) {
	p.mu.Lock()
	p.net = n
	fn := p.netFn
	p.mu.Unlock()
	if fn != nil {
		fn(n)
	}
}

func (p *fakePlatform) counts() (bg, ended int) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.bgCalls, p.ended
}

func (p *fakePlatform) callbacks() (background, active, expiring func()) {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.bgFn, p.actFn, p.expiring
}

// events captures what the service emits.
type events struct {
	mu   sync.Mutex
	list []event
}

type event struct {
	name string
	data any
}

func (e *events) add(name string, data any) {
	e.mu.Lock()
	e.list = append(e.list, event{name, data})
	e.mu.Unlock()
}

func (e *events) count(name string) int {
	e.mu.Lock()
	defer e.mu.Unlock()
	n := 0
	for _, ev := range e.list {
		if ev.name == name {
			n++
		}
	}
	return n
}

// states are the states a download was announced in, in order.
func (e *events) states(id string) []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for _, ev := range e.list {
		if d, ok := ev.data.(store.Download); ok && ev.name == EventChanged && d.ID == id {
			out = append(out, d.State)
		}
	}
	return out
}

func (e *events) removed() []string {
	e.mu.Lock()
	defer e.mu.Unlock()
	var out []string
	for _, ev := range e.list {
		if r, ok := ev.data.(Removed); ok {
			out = append(out, r.IDs...)
		}
	}
	return out
}

// rig is a service on a temp store, a fake platform and a fake Resolve.
type rig struct {
	t       *testing.T
	s       *Service
	st      *store.Store
	plat    *fakePlatform
	ev      *events
	profile store.Profile
	root    string

	target     atomic.Value // the URL Resolve answers with
	resolves   atomic.Int32
	resolveFn  func(n int, req streams.Request) (streams.Source, error)
	skipStart  bool
}

func noStart(r *rig) { r.skipStart = true }

func newRig(t *testing.T, opts ...func(*rig)) *rig {
	t.Helper()
	st, err := store.Open(filepath.Join(t.TempDir(), "Peli", "peli.db"))
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { st.Close() })
	r := &rig{
		t: t, st: st, ev: &events{}, root: filepath.Join(t.TempDir(), "Downloads"),
		plat: &fakePlatform{net: Network{Online: true}, free: 500 << 30},
	}
	if r.profile, err = st.CreateProfile(store.Profile{Name: "Me"}); err != nil {
		t.Fatal(err)
	}
	r.s = NewService(Config{
		Open: func() *store.Store { return st }, Resolve: r.resolve,
		Root: r.root, Version: "test", Platform: r.plat,
	})
	r.s.emit = r.ev.add
	r.s.backoffMin, r.s.backoffMax = 10*time.Millisecond, 40*time.Millisecond
	r.s.progressEvery, r.s.saveEvery = 0, 0
	r.s.stall = 5 * time.Second
	r.s.shutdownWait = 5 * time.Second
	for _, opt := range opts {
		opt(r)
	}
	if !r.skipStart {
		if err := r.s.ServiceStartup(context.Background(), application.ServiceOptions{}); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { r.s.ServiceShutdown() })
	}
	return r
}

func (r *rig) resolve(_ context.Context, req streams.Request) (streams.Source, error) {
	n := int(r.resolves.Add(1))
	if r.resolveFn != nil {
		return r.resolveFn(n, req)
	}
	target, _ := r.target.Load().(string)
	return streams.Source{URL: target, Origin: req.URL, ContentType: "video/mp4"}, nil
}

func (r *rig) serve(f *fileServer) { r.target.Store(f.URL + "/video") }

func (r *rig) request(videoID string) AddRequest {
	return AddRequest{
		ProfileID: r.profile.ID, ContentID: "tt0903747", ContentType: "movie", VideoID: videoID,
		Name: "Film", MetaAddon: addonA,
		StreamSource: addonA, StreamName: "Stream", Resolution: "1080p",
		Request: streams.Request{URL: "https://a.example/stream/" + videoID},
	}
}

func (r *rig) add(videoID string) store.Download {
	r.t.Helper()
	d, err := r.s.Add(r.request(videoID))
	if err != nil {
		r.t.Fatal(err)
	}
	return d
}

func (r *rig) get(id string) store.Download {
	r.t.Helper()
	d, err := r.st.Download(id)
	if err != nil || d == nil {
		r.t.Fatalf("download %s: %v", id, err)
	}
	return *d
}

func waitFor(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func (r *rig) waitState(id, state string) store.Download {
	r.t.Helper()
	waitFor(r.t, "state "+state, func() bool {
		d, err := r.st.Download(id)
		return err == nil && d != nil && d.State == state
	})
	return r.get(id)
}

func (r *rig) waitBytes(id string, atLeast int64) {
	r.t.Helper()
	waitFor(r.t, "bytes", func() bool {
		d, err := r.st.Download(id)
		return err == nil && d != nil && d.Bytes >= atLeast
	})
}

func (r *rig) path(rel string) string { return filepath.Join(r.root, filepath.FromSlash(rel)) }

func (r *rig) read(rel string) []byte {
	r.t.Helper()
	data, err := os.ReadFile(r.path(rel))
	if err != nil {
		r.t.Fatal(err)
	}
	return data
}

func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

func holdFirst(n int) func(*fileServer) {
	return func(f *fileServer) {
		f.holdAfter = func(hit int) int {
			if hit == 1 {
				return n
			}
			return 0
		}
	}
}
