// Package subsync lines up an addon's subtitles with the video playing
// (docs/spikes/subtitle-autosync.md, after Nuvio's AutoSync): the file's
// own subtitles' timing, read from its Matroska index, is the reference,
// and the addon file's line times are aligned to it, no text or audio
// involved. A confident fit gives a retimed copy of the file.
package subsync

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"
)

// ErrNoReference: the file has nothing to line subtitles up with (no
// subtitle tracks, or none in its index, or it isn't Matroska).
var ErrNoReference = errors.New("subsync: no reference")

// LoadWait caps reading a file's reference.
const LoadWait = 15 * time.Second

// Source is the file playing: a URL with the request headers and user
// agent it needs, or a path on the disk (a download).
type Source struct {
	URL       string
	Headers   map[string]string
	UserAgent string
	// Path is a file on the disk; URL is ignored then.
	Path string
}

// Reference is the file's own subtitle timing.
type Reference struct {
	Tracks []Track
}

// Track is one of the file's subtitle tracks: the times its packets start,
// in ms. A picture track (PGS) has a packet for each line's start and
// another for its clearing.
type Track struct {
	Language string
	Picture  bool
	Forced   bool
	Times    []int64
}

// Load reads src's reference. Only Matroska and WebM files have one.
func Load(ctx context.Context, client *http.Client, src Source) (*Reference, error) {
	ctx, cancel := context.WithTimeout(ctx, LoadWait)
	defer cancel()
	var r ranges
	switch {
	case src.Path != "":
		f, err := os.Open(src.Path)
		if err != nil {
			return nil, err
		}
		defer f.Close()
		r = &fileRanges{f: f}
	case strings.HasPrefix(src.URL, "http://") || strings.HasPrefix(src.URL, "https://"):
		r = &httpRanges{client: client, src: src}
	default:
		return nil, ErrNoReference
	}
	ref, err := loadMatroska(ctx, r)
	if errors.Is(err, errNotMatroska) {
		return nil, fmt.Errorf("%w: not Matroska", ErrNoReference)
	}
	return ref, err
}

// Pending is a reference being read in the background: started when a
// file loads, so it's there by the time its subtitles are added.
type Pending struct {
	done   chan struct{}
	cancel context.CancelFunc
	ref    *Reference
	err    error
}

// Start reads src's reference in the background.
func Start(client *http.Client, src Source) *Pending {
	ctx, cancel := context.WithCancel(context.Background())
	p := &Pending{done: make(chan struct{}), cancel: cancel}
	go func() {
		defer close(p.done)
		p.ref, p.err = Load(ctx, client, src)
	}()
	return p
}

// Wait returns the reference once read, or ctx's error first. A failed
// read stays failed: it isn't tried again for the same file.
func (p *Pending) Wait(ctx context.Context) (*Reference, error) {
	select {
	case <-p.done:
		return p.ref, p.err
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// Cancel stops the read; Wait then returns an error.
func (p *Pending) Cancel() { p.cancel() }

// httpRanges reads a URL with Range requests and the stream's headers.
type httpRanges struct {
	client *http.Client
	src    Source
	mu     sync.Mutex
	size   int64
}

func (h *httpRanges) Size() int64 {
	h.mu.Lock()
	defer h.mu.Unlock()
	return h.size
}

// errRange: the server didn't answer a range (most say 206; this one
// didn't, or said 4xx/5xx). Its errors name no URL: stream links carry
// debrid keys.
var errRange = errors.New("subsync: range not served")

func (h *httpRanges) ReadAt(ctx context.Context, off, n int64) ([]byte, error) {
	data, err := h.read(ctx, off, n)
	// Debrid CDNs sometimes refuse a fresh link's first request.
	if errors.Is(err, errRange) && ctx.Err() == nil {
		select {
		case <-time.After(time.Second):
		case <-ctx.Done():
			return nil, ctx.Err()
		}
		data, err = h.read(ctx, off, n)
	}
	return data, err
}

func (h *httpRanges) read(ctx context.Context, off, n int64) ([]byte, error) {
	if size := h.Size(); size > 0 {
		if off >= size {
			return nil, io.EOF
		}
		n = min(n, size-off)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, h.src.URL, nil)
	if err != nil {
		return nil, errRange
	}
	for name, value := range h.src.Headers {
		req.Header.Set(name, value)
	}
	if h.src.UserAgent != "" {
		req.Header.Set("User-Agent", h.src.UserAgent)
	}
	req.Header.Set("Range", "bytes="+strconv.FormatInt(off, 10)+"-"+strconv.FormatInt(off+n-1, 10))
	resp, err := h.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, fmt.Errorf("%w: unreachable", errRange)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		return nil, fmt.Errorf("%w: status %d", errRange, resp.StatusCode)
	}
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		if i := strings.LastIndexByte(cr, '/'); i >= 0 {
			if total, err := strconv.ParseInt(cr[i+1:], 10, 64); err == nil {
				h.mu.Lock()
				h.size = total
				h.mu.Unlock()
			}
		}
	}
	return io.ReadAll(io.LimitReader(resp.Body, n))
}

type fileRanges struct {
	f    *os.File
	size int64
}

func (f *fileRanges) Size() int64 {
	if f.size == 0 {
		if st, err := f.f.Stat(); err == nil {
			f.size = st.Size()
		}
	}
	return f.size
}

func (f *fileRanges) ReadAt(_ context.Context, off, n int64) ([]byte, error) {
	size := f.Size()
	if off >= size {
		return nil, io.EOF
	}
	buf := make([]byte, min(n, size-off))
	got, err := f.f.ReadAt(buf, off)
	if err == io.EOF {
		err = nil
	}
	return buf[:got], err
}
