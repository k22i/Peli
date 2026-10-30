// Command ttff measures time to first frame for a debrid stream (#53): from
// the pick, through internal/streams' resolve, to mpv's first frame, with the
// download capped to a line speed. mpv runs idle beforehand, as libmpv will
// in the app (#60), and gets the Source the way the player will: user-agent
// and http-header-fields set, then loadfile.
//
//	set -a; . spikes/stream-ranking/.env; set +a
//	go run ./tools/ttff -id movie/tt0111161 -hash c3da9a3d… -mbps 50 -runs 5
//
// It asks Torrentio with TorBox for the title's streams and plays the one
// whose resolve URL holds -hash. Pick a torrent already in the TorBox
// account: resolving one that isn't adds it there. Nothing it prints holds
// the key or a link's token; links are shown by host only.
package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/k22i/Sinag/internal/streams"
)

func main() {
	id := flag.String("id", "movie/tt0111161", "type/id to ask Torrentio for")
	hashes := flag.String("hash", "", "comma-separated infohashes of the streams to resolve")
	mbps := flag.Float64("mbps", 50, "download cap in Mbit/s; 0 for none")
	runs := flag.Int("runs", 5, "plays per stream that resolves")
	mpvPath := flag.String("mpv", "mpv", "mpv binary")
	flag.Parse()
	key := os.Getenv("TORBOX_API_KEY")
	if key == "" || *hashes == "" {
		log.Fatal("needs TORBOX_API_KEY and -hash")
	}
	redact := strings.NewReplacer(key, "<key>")
	log.SetFlags(0)
	log.SetOutput(redactWriter{os.Stderr, redact})

	list, err := torrentio(key, *id)
	if err != nil {
		log.Fatalf("torrentio: %v", err)
	}
	resolver := streams.NewService("0.0.0-ttff")
	player, err := startMPV(*mpvPath)
	if err != nil {
		log.Fatalf("mpv: %v", err)
	}
	defer player.close()

	for hash := range strings.SplitSeq(*hashes, ",") {
		i := slices.IndexFunc(list, func(s stream) bool { return strings.Contains(s.URL, "/"+hash+"/") })
		if i < 0 {
			fmt.Printf("%s: not in Torrentio's answer\n", hash[:8])
			continue
		}
		s := list[i]
		fmt.Printf("%s: %s\n", hash[:8], strings.ReplaceAll(s.Name, "\n", " "))
		for run := range max(*runs, 1) {
			started := time.Now()
			src, err := resolver.Resolve(context.Background(), streams.Request{URL: s.URL, Headers: s.Headers()})
			resolved := time.Since(started)
			if err != nil {
				fmt.Printf("  resolve: %s after %v\n", streams.MarshalError(err), resolved.Round(time.Millisecond))
				break
			}
			if run == 0 {
				final, _ := url.Parse(src.URL)
				fmt.Printf("  resolves to %s, %s, %.2f GB; the CDN's first byte on a new connection takes %v\n",
					final.Host, src.ContentType, float64(src.Size)/1e9, firstByte(src).Round(time.Millisecond))
			}
			if *runs == 0 {
				break
			}
			proxy := newThrottle(src, *mbps)
			loaded, read, err := player.firstFrame(src, proxy)
			_ = proxy.Close()
			if err != nil {
				fmt.Printf("  run %d: %v\n", run+1, err)
				continue
			}
			fmt.Printf("  run %d: resolve %4d ms + load %4d ms = %4d ms to first frame (%.1f MB read)\n",
				run+1, resolved.Milliseconds(), loaded.Milliseconds(),
				(resolved + loaded).Milliseconds(), float64(read)/1e6)
		}
	}
}

type stream struct {
	Name          string `json:"name"`
	URL           string `json:"url"`
	BehaviorHints struct {
		ProxyHeaders struct {
			Request map[string]string `json:"request"`
		} `json:"proxyHeaders"`
	} `json:"behaviorHints"`
}

func (s stream) Headers() map[string]string { return s.BehaviorHints.ProxyHeaders.Request }

func torrentio(key, id string) ([]stream, error) {
	req, _ := http.NewRequest(http.MethodGet, "https://torrentio.strem.fun/torbox="+key+"/stream/"+id+".json", nil)
	// Torrentio turns Go's own User-Agent away (403).
	req.Header.Set("User-Agent", "Sinag/0.0.0-ttff (+https://github.com/k22i/Sinag)")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return nil, errors.New("unreachable")
	}
	defer resp.Body.Close()
	var answer struct{ Streams []stream }
	if err := json.NewDecoder(resp.Body).Decode(&answer); err != nil {
		return nil, fmt.Errorf("status %d", resp.StatusCode)
	}
	return answer.Streams, nil
}

// firstByte times what the player pays to open the resolved link afresh:
// DNS, TCP, TLS and the CDN's first byte.
func firstByte(src streams.Source) time.Duration {
	client := &http.Client{Transport: &http.Transport{}}
	req, _ := http.NewRequest(http.MethodGet, src.URL, nil)
	req.Header.Set("User-Agent", src.UserAgent)
	req.Header.Set("Range", "bytes=0-0")
	started := time.Now()
	resp, err := client.Do(req)
	if err != nil {
		return 0
	}
	_ = resp.Body.Close()
	return time.Since(started)
}

// --- The line: a proxy capping the download --------------------------------

type throttle struct {
	*http.Server
	URL  string
	read *counter
}

type counter struct {
	sync.Mutex
	n int64
}

func (c *counter) add(n int) {
	c.Lock()
	c.n += int64(n)
	c.Unlock()
}

func (c *counter) Load() int64 {
	c.Lock()
	defer c.Unlock()
	return c.n
}

// newThrottle serves src's file on loopback at mbps, shared across mpv's
// connections, passing Range and the Source's headers on.
func newThrottle(src streams.Source, mbps float64) *throttle {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		log.Fatal(err)
	}
	t := &throttle{URL: "http://" + ln.Addr().String() + "/file", read: &counter{}}
	var mu sync.Mutex
	next := time.Now()
	wait := func(n int) {
		if mbps <= 0 {
			return
		}
		mu.Lock()
		if now := time.Now(); next.Before(now) {
			next = now
		}
		next = next.Add(time.Duration(float64(n*8) / (mbps * 1e6) * float64(time.Second)))
		until := next
		mu.Unlock()
		time.Sleep(time.Until(until))
	}
	t.Server = &http.Server{Handler: http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		req, _ := http.NewRequestWithContext(r.Context(), r.Method, src.URL, nil)
		for name, value := range src.Headers {
			req.Header.Set(name, value)
		}
		req.Header.Set("User-Agent", src.UserAgent)
		if rng := r.Header.Get("Range"); rng != "" {
			req.Header.Set("Range", rng)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			http.Error(w, "upstream", http.StatusBadGateway)
			return
		}
		defer resp.Body.Close()
		for _, name := range []string{"Content-Type", "Content-Length", "Content-Range", "Accept-Ranges"} {
			if v := resp.Header.Get(name); v != "" {
				w.Header().Set(name, v)
			}
		}
		w.WriteHeader(resp.StatusCode)
		buf := make([]byte, 32<<10)
		for {
			n, err := resp.Body.Read(buf)
			if n > 0 {
				wait(n)
				if _, werr := w.Write(buf[:n]); werr != nil {
					return
				}
				t.read.add(n)
			}
			if err != nil {
				return
			}
		}
	})}
	go func() { _ = t.Serve(ln) }()
	return t
}

// --- mpv over its JSON IPC --------------------------------------------------

type mpv struct {
	cmd    *exec.Cmd
	conn   net.Conn
	events chan map[string]any
	mu     sync.Mutex
}

func startMPV(bin string) (*mpv, error) {
	dir, err := os.MkdirTemp("", "ttff")
	if err != nil {
		return nil, err
	}
	sock := filepath.Join(dir, "mpv.sock")
	// No window and no sound: the frame is decoded and handed to a null VO.
	cmd := exec.Command(bin, "--no-config", "--idle=yes", "--input-ipc-server="+sock,
		"--vo=null", "--ao=null", "--hwdec=auto-copy", "--msg-level=all=error")
	cmd.Stderr = os.Stderr
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	var conn net.Conn
	for range 100 {
		if conn, err = net.Dial("unix", sock); err == nil {
			break
		}
		time.Sleep(20 * time.Millisecond)
	}
	if conn == nil {
		return nil, err
	}
	m := &mpv{cmd: cmd, conn: conn, events: make(chan map[string]any, 64)}
	go func() {
		scanner := bufio.NewScanner(conn)
		for scanner.Scan() {
			var msg map[string]any
			if json.Unmarshal(scanner.Bytes(), &msg) == nil && msg["event"] != nil {
				m.events <- msg
			}
		}
		close(m.events)
	}()
	return m, nil
}

func (m *mpv) send(args ...any) {
	m.mu.Lock()
	defer m.mu.Unlock()
	data, _ := json.Marshal(map[string]any{"command": args})
	_, _ = m.conn.Write(append(data, '\n'))
}

// firstFrame loads src (served by proxy) and waits for playback-restart:
// the first frame decoded and shown. It gives the time and the bytes read by
// then.
func (m *mpv) firstFrame(src streams.Source, proxy *throttle) (time.Duration, int64, error) {
	for len(m.events) > 0 {
		<-m.events
	}
	started := time.Now()
	m.send("set_property", "user-agent", src.UserAgent)
	m.send("set_property", "http-header-fields", src.HeaderFields())
	m.send("loadfile", proxy.URL, "replace")
	timeout := time.After(60 * time.Second)
	for {
		select {
		case e, ok := <-m.events:
			if !ok {
				return 0, 0, io.ErrUnexpectedEOF
			}
			switch e["event"] {
			case "playback-restart":
				took, read := time.Since(started), proxy.read.Load()
				m.send("stop")
				m.waitIdle()
				return took, read, nil
			case "end-file":
				if e["reason"] == "error" {
					return 0, 0, fmt.Errorf("mpv: %v", e["file_error"])
				}
			}
		case <-timeout:
			m.send("stop")
			return 0, 0, errors.New("no first frame in 60 s")
		}
	}
}

func (m *mpv) waitIdle() {
	for e := range m.events {
		if e["event"] == "idle" {
			return
		}
	}
}

func (m *mpv) close() {
	m.send("quit")
	_ = m.cmd.Wait()
}

type redactWriter struct {
	w io.Writer
	r *strings.Replacer
}

func (w redactWriter) Write(p []byte) (int, error) {
	_, err := io.WriteString(w.w, w.r.Replace(string(p)))
	return len(p), err
}
