package main

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// Ranged reads one HTTP resource with Range requests and counts what it
// cost. Peli's real loader would reuse the player's resolved Source (URL,
// headers, user agent); the spike only has a bare CDN link.
type Ranged struct {
	URL    string
	Client *http.Client
	UA     string

	mu       sync.Mutex
	Size     int64 // from Content-Range, once known
	Requests int
	Bytes    int64
	Elapsed  time.Duration
}

var errNoRange = errors.New("server ignored Range")

func newRanged(url string) *Ranged {
	return &Ranged{
		URL:    url,
		Client: &http.Client{Timeout: 30 * time.Second},
		UA:     "Peli-spike/0.1",
	}
}

// Read returns up to n bytes from off. Past the end it returns what there is.
// TorBox's CDN sometimes answers a fresh link with a 400 once: one retry.
func (r *Ranged) Read(ctx context.Context, off, n int64) ([]byte, error) {
	data, err := r.read(ctx, off, n)
	if errors.Is(err, errNoRange) {
		time.Sleep(time.Second)
		data, err = r.read(ctx, off, n)
	}
	return data, err
}

func (r *Ranged) read(ctx context.Context, off, n int64) ([]byte, error) {
	if n <= 0 {
		return nil, nil
	}
	if r.Size > 0 {
		if off >= r.Size {
			return nil, io.EOF
		}
		if off+n > r.Size {
			n = r.Size - off
		}
	}
	start := time.Now()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.URL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("User-Agent", r.UA)
	req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", off, off+n-1))
	resp, err := r.Client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusPartialContent {
		return nil, fmt.Errorf("%w: status %d", errNoRange, resp.StatusCode)
	}
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		if i := strings.LastIndexByte(cr, '/'); i >= 0 {
			if total, err := strconv.ParseInt(cr[i+1:], 10, 64); err == nil {
				r.mu.Lock()
				r.Size = total
				r.mu.Unlock()
			}
		}
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, n))
	r.mu.Lock()
	r.Requests++
	r.Bytes += int64(len(data))
	r.Elapsed += time.Since(start)
	r.mu.Unlock()
	return data, err
}

// Tail reads the last n bytes.
func (r *Ranged) Tail(ctx context.Context, n int64) (int64, []byte, error) {
	if r.Size == 0 {
		if _, err := r.Read(ctx, 0, 1); err != nil {
			return 0, nil, err
		}
	}
	off := r.Size - n
	if off < 0 {
		off = 0
	}
	data, err := r.Read(ctx, off, r.Size-off)
	return off, data, err
}
