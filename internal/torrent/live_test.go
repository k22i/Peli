package torrent

import (
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Blender's open films (Creative Commons), as WebTorrent's examples share
// them: real public swarms to stream from.
var liveTorrents = []struct {
	name, hash, file string
}{
	{"Sintel", "08ada5a7a6183aae1e09d831df6748d566095a10", "Sintel.mp4"},
	{"Big Buck Bunny", "dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c", "Big Buck Bunny.mp4"},
}

// TestLive streams from the real DHT and trackers: time to the file list,
// to the first megabyte and after a seek, the speed, and the process's
// memory. Run with PELI_TORRENT_LIVE=1 go test -v -run TestLive.
func TestLive(t *testing.T) {
	if os.Getenv("PELI_TORRENT_LIVE") == "" {
		t.Skip("set PELI_TORRENT_LIVE=1 to stream from public swarms")
	}
	for _, live := range liveTorrents {
		t.Run(live.name, func(t *testing.T) {
			svc := NewService(on, t.TempDir(), "live")
			defer svc.ServiceShutdown()

			start := time.Now()
			source, err := svc.Open(t.Context(), Request{InfoHash: live.hash, FileName: live.file})
			if err != nil {
				t.Skipf("%s: %v after %v", live.name, err, time.Since(start))
			}
			t.Logf("file list after %v: %s, %d MB", time.Since(start).Round(time.Millisecond),
				source.ContentType, source.Size/1_000_000)

			read := func(from int64, n int64) time.Duration {
				began := time.Now()
				req, _ := http.NewRequestWithContext(t.Context(), http.MethodGet, source.URL, nil)
				req.Header.Set("Range", fmt.Sprintf("bytes=%d-%d", from, from+n-1))
				resp, err := http.DefaultClient.Do(req)
				check(t, err)
				defer resp.Body.Close()
				got, err := io.Copy(io.Discard, resp.Body)
				check(t, err)
				if got != n {
					t.Fatalf("read %d bytes, want %d", got, n)
				}
				return time.Since(began)
			}
			t.Logf("first 1 MB in %v", read(0, 1<<20).Round(time.Millisecond))
			took := read(1<<20, 20<<20)
			t.Logf("next 20 MB in %v (%.1f MB/s)", took.Round(time.Millisecond),
				20*1.048576/took.Seconds())
			t.Logf("1 MB after seeking to the middle in %v",
				read(source.Size/2, 1<<20).Round(time.Millisecond))
			status := svc.Status()
			t.Logf("status: %+v", status)
			t.Logf("cache %d MB, memory: %s", svc.CacheSize()/1_000_000, memory())
		})
	}
}

// memory is the process's resident size and the Go heap.
func memory() string {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	rss := "?"
	if out, err := exec.Command("ps", "-o", "rss=", "-p", strconv.Itoa(os.Getpid())).Output(); err == nil {
		if kb, err := strconv.Atoi(strings.TrimSpace(string(out))); err == nil {
			rss = fmt.Sprintf("%d MB", kb/1000)
		}
	}
	return fmt.Sprintf("RSS %s, heap %d MB", rss, m.HeapInuse/1_000_000)
}
