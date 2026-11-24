package main

import (
	"io"
	"net"
	"net/http"
	"sync"
	"sync/atomic"
)

// counter sits between mpv and the upstream (a debrid CDN link, or a local
// file served over HTTP) on loopback, and counts what each thumbnail costs.
// The Range header goes through unchanged.
type counter struct {
	upstream string
	ua       string
	client   *http.Client

	bytes    atomic.Int64
	requests atomic.Int64

	mu     sync.Mutex
	ranges []string
}

func (c *counter) take() (bytes, requests int64, ranges []string) {
	c.mu.Lock()
	ranges, c.ranges = c.ranges, nil
	c.mu.Unlock()
	return c.bytes.Swap(0), c.requests.Swap(0), ranges
}

func (c *counter) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	c.requests.Add(1)
	req, _ := http.NewRequestWithContext(r.Context(), r.Method, c.upstream, nil)
	if rg := r.Header.Get("Range"); rg != "" {
		req.Header.Set("Range", rg)
		c.mu.Lock()
		c.ranges = append(c.ranges, rg)
		c.mu.Unlock()
	}
	req.Header.Set("User-Agent", c.ua)
	resp, err := c.client.Do(req)
	if err != nil {
		http.Error(w, "upstream", http.StatusBadGateway)
		return
	}
	defer resp.Body.Close()
	for _, h := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"} {
		if v := resp.Header.Get(h); v != "" {
			w.Header().Set(h, v)
		}
	}
	w.WriteHeader(resp.StatusCode)
	buf := make([]byte, 64<<10)
	for {
		n, err := resp.Body.Read(buf)
		if n > 0 {
			c.bytes.Add(int64(n))
			if _, werr := w.Write(buf[:n]); werr != nil {
				return // mpv closed the connection (a seek): the rest isn't read
			}
		}
		if err == io.EOF || err != nil {
			return
		}
	}
}

// serve starts the counter on a loopback port and returns its URL.
func serve(c *counter, name string) (string, func()) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		panic(err)
	}
	srv := &http.Server{Handler: c}
	go srv.Serve(ln)
	return "http://" + ln.Addr().String() + "/" + name, func() { srv.Close() }
}
