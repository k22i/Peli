package torrent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	alog "github.com/anacrolix/log"
	"github.com/anacrolix/torrent"
	"github.com/anacrolix/torrent/bencode"
	"github.com/anacrolix/torrent/metainfo"

	"github.com/k22i/Peli/internal/store"
)

type settings struct{ device store.DeviceSettings }

func (s settings) DeviceSettings() (store.DeviceSettings, error) { return s.device, nil }

var on = settings{store.DeviceSettings{TorrentStreaming: true, TorrentCacheGB: 5}}

// swarm is a seeder on loopback with a torrent of files, and their bytes.
type swarm struct {
	client *torrent.Client
	hash   metainfo.Hash
	files  map[string][]byte
}

func quiet(cfg *torrent.ClientConfig) {
	cfg.NoDHT = true
	cfg.DisableTrackers = true
	cfg.NoDefaultPortForwarding = true
	cfg.DisableWebtorrent = true
	cfg.DisableIPv6 = true
	cfg.KeepAliveTimeout = keepAlive
	cfg.ListenPort = 0
	cfg.Slogger = slog.New(slog.DiscardHandler)
	cfg.Logger = alog.Default.WithFilterLevel(alog.Disabled)
}

// seed makes a torrent named "Show" of files (path → size), with pieces of
// pieceLength, and seeds it.
func seed(t *testing.T, pieceLength int64, sizes map[string]int) swarm {
	t.Helper()
	dir := seederDir(t)
	files := map[string][]byte{}
	rng := rand.New(rand.NewPCG(1, uint64(len(sizes))))
	for name, size := range sizes {
		data := make([]byte, size)
		for i := range data {
			data[i] = byte(rng.Uint32())
		}
		files[name] = data
		full := filepath.Join(dir, "Show", name)
		check(t, os.MkdirAll(filepath.Dir(full), 0o700))
		check(t, os.WriteFile(full, data, 0o600))
	}
	info := metainfo.Info{PieceLength: pieceLength}
	check(t, info.BuildFromFilePath(filepath.Join(dir, "Show")))
	var mi metainfo.MetaInfo
	var err error
	mi.InfoBytes, err = bencode.Marshal(info)
	check(t, err)

	cfg := torrent.NewDefaultClientConfig()
	quiet(cfg)
	cfg.DataDir = dir
	cfg.Seed = true
	client, err := torrent.NewClient(cfg)
	check(t, err)
	t.Cleanup(func() { client.Close() })
	tor, err := client.AddTorrent(&mi)
	check(t, err)
	check(t, tor.VerifyData())
	return swarm{client, mi.HashInfoBytes(), files}
}

// seederDir is the seeder's data folder. Not t.TempDir: on Windows
// anacrolix's file storage can still hold a file open after client.Close,
// and an open file can't be removed, which fails t.TempDir's cleanup. The
// seeder is test scaffolding (the Service under test has its own cache),
// so the folder is removed once the handles go, or left in the temp dir.
func seederDir(t *testing.T) string {
	t.Helper()
	dir, err := os.MkdirTemp("", "peli-seeder-")
	check(t, err)
	t.Cleanup(func() {
		deadline := time.Now().Add(5 * time.Second)
		for {
			err := os.RemoveAll(dir)
			if err == nil {
				return
			}
			if time.Now().After(deadline) {
				if runtime.GOOS != "windows" {
					t.Errorf("seeder folder: %v", err)
				}
				return
			}
			time.Sleep(50 * time.Millisecond)
		}
	})
	return dir
}

// engine is a Service whose torrents find only the swarm's seeder.
func engine(t *testing.T, sw *swarm, s Settings) *Service {
	t.Helper()
	svc := NewService(s, t.TempDir(), "test")
	svc.trackers = nil
	svc.metadataWait = 5 * time.Second
	svc.configure = quiet
	svc.added = func(tor *torrent.Torrent) {
		if sw != nil {
			tor.AddClientPeer(sw.client)
		}
	}
	t.Cleanup(func() { check(t, svc.ServiceShutdown()) })
	return svc
}

func get(t *testing.T, url string, header http.Header) (*http.Response, []byte) {
	t.Helper()
	req, err := http.NewRequest(http.MethodGet, url, nil)
	check(t, err)
	for name, values := range header {
		req.Header[name] = values
	}
	resp, err := http.DefaultClient.Do(req)
	check(t, err)
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	check(t, err)
	return resp, body
}

func ptr[T any](v T) *T { return &v }

// The acceptance criterion: a torrent's file plays through a loopback link,
// whole and from any point (seeks are ranges).
func TestOpenServesTheFileWithRanges(t *testing.T) {
	sw := seed(t, 64<<10, map[string]int{
		"Show.S01E01.mkv": 3<<20 + 1234,
		"Show.S01E02.mkv": 2 << 20,
		"sample.txt":      100,
	})
	svc := engine(t, &sw, on)

	source, err := svc.Open(t.Context(), Request{
		InfoHash: sw.hash.HexString(), FileIdx: ptr(0), FileName: "Show.S01E01.mkv",
	})
	check(t, err)
	want := sw.files["Show.S01E01.mkv"]
	if !strings.HasPrefix(source.URL, "http://127.0.0.1:") || source.Size != int64(len(want)) ||
		source.ContentType != "video/x-matroska" || !strings.HasPrefix(source.Origin, "magnet:") {
		t.Fatalf("source = %+v", source)
	}

	resp, body := get(t, source.URL, nil)
	if resp.StatusCode != http.StatusOK || !bytes.Equal(body, want) {
		t.Fatalf("whole file: %d, %d bytes, equal %v", resp.StatusCode, len(body), bytes.Equal(body, want))
	}
	if got := resp.Header.Get("Content-Type"); got != "video/x-matroska" {
		t.Errorf("Content-Type = %q", got)
	}
	from := int64(len(want)) - 300_000
	resp, body = get(t, source.URL, http.Header{"Range": {fmt.Sprintf("bytes=%d-", from)}})
	if resp.StatusCode != http.StatusPartialContent || !bytes.Equal(body, want[from:]) {
		t.Fatalf("range: %d, %d bytes", resp.StatusCode, len(body))
	}

	status := svc.Status()
	if !status.Active || !status.Ready || status.Peers < 1 || status.Size != int64(len(want)) ||
		status.Done != status.Size {
		t.Errorf("status = %+v", status)
	}
}

// A file larger than the cache still plays whole, and again from the start:
// pieces the cache drops are fetched again when read.
func TestStreamsAFileLargerThanTheCache(t *testing.T) {
	sw := seed(t, 32<<10, map[string]int{"Film.mp4": 4 << 20})
	svc := engine(t, &sw, on)
	svc.readahead = 256 << 10
	source, err := svc.Open(t.Context(), Request{InfoHash: sw.hash.HexString(), FileIdx: ptr(0)})
	check(t, err)
	svc.SetCacheSize(0) // no effect: not a size
	svc.mu.Lock()
	svc.cache.SetMax(1 << 20)
	svc.mu.Unlock()

	for range 2 {
		_, body := get(t, source.URL, nil)
		if !bytes.Equal(body, sw.files["Film.mp4"]) {
			t.Fatalf("got %d bytes, not the file", len(body))
		}
		if size := svc.CacheSize(); size > 1<<20 {
			t.Errorf("cache holds %d bytes, over its cap", size)
		}
	}
}

func TestOpenRefusals(t *testing.T) {
	sw := seed(t, 64<<10, map[string]int{"notes.txt": 1000})
	for name, test := range map[string]struct {
		settings Settings
		req      Request
		want     error
	}{
		"turned off": {settings{store.DefaultDeviceSettings()}, Request{InfoHash: sw.hash.HexString()}, ErrDisabled},
		"bad hash":   {on, Request{InfoHash: "not-a-hash"}, ErrInvalid},
		"short hash": {on, Request{InfoHash: "abcdef"}, ErrInvalid},
		"no video":   {on, Request{InfoHash: sw.hash.HexString()}, ErrNoFile},
	} {
		t.Run(name, func(t *testing.T) {
			svc := engine(t, &sw, test.settings)
			if _, err := svc.Open(t.Context(), test.req); !errors.Is(err, test.want) {
				t.Fatalf("err = %v, want %v", err, test.want)
			}
			if svc.Status().Active {
				t.Error("a refused torrent stays open")
			}
		})
	}
}

func TestOpenWithoutPeers(t *testing.T) {
	svc := engine(t, nil, on)
	svc.metadataWait = 200 * time.Millisecond
	_, err := svc.Open(t.Context(), Request{InfoHash: strings.Repeat("ab", 20)})
	if !errors.Is(err, ErrNoPeers) {
		t.Fatalf("err = %v", err)
	}
	if string(MarshalError(err)) != `{"code":"no_peers"}` {
		t.Errorf("code = %s", MarshalError(err))
	}

	ctx, cancel := context.WithCancel(t.Context())
	time.AfterFunc(50*time.Millisecond, cancel)
	svc.metadataWait = time.Minute
	if _, err := svc.Open(ctx, Request{InfoHash: strings.Repeat("cd", 20)}); !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled: err = %v", err)
	}
	if svc.Status().Active {
		t.Error("a cancelled torrent stays open")
	}
}

// Only the player gets the file: the link's secret, the torrent playing and
// a loopback Host are all needed.
func TestServerRefusesOtherRequests(t *testing.T) {
	sw := seed(t, 64<<10, map[string]int{"Film.mkv": 256 << 10})
	svc := engine(t, &sw, on)
	source, err := svc.Open(t.Context(), Request{InfoHash: sw.hash.HexString()})
	check(t, err)
	base := source.URL[:strings.Index(source.URL, svc.secret)]
	rest := strings.TrimPrefix(source.URL, base+svc.secret)

	for name, test := range map[string]struct {
		url  string
		host string
	}{
		"no secret":    {base + rest, ""},
		"wrong secret": {base + strings.Repeat("0", len(svc.secret)) + rest, ""},
		"other file":   {base + svc.secret + "/" + sw.hash.HexString() + "/1/x.mkv", ""},
		"other hash":   {base + svc.secret + "/" + strings.Repeat("ab", 20) + "/0/x.mkv", ""},
		"named host":   {source.URL, "peli.example:80"},
	} {
		t.Run(name, func(t *testing.T) {
			req, err := http.NewRequest(http.MethodGet, test.url, nil)
			check(t, err)
			if test.host != "" {
				req.Host = test.host
			}
			resp, err := http.DefaultClient.Do(req)
			check(t, err)
			resp.Body.Close()
			if resp.StatusCode != http.StatusNotFound {
				t.Fatalf("status = %d", resp.StatusCode)
			}
		})
	}

	svc.Release()
	if resp, _ := get(t, source.URL, nil); resp.StatusCode != http.StatusNotFound {
		t.Fatalf("after Release: status = %d", resp.StatusCode)
	}
	if svc.Status().Active {
		t.Error("Release left the torrent open")
	}
}

// Opening another torrent replaces the one playing.
func TestOpenReplaces(t *testing.T) {
	a := seed(t, 64<<10, map[string]int{"A.mkv": 128 << 10})
	b := seed(t, 64<<10, map[string]int{"B.mkv": 192 << 10})
	svc := engine(t, &a, on)
	first, err := svc.Open(t.Context(), Request{InfoHash: a.hash.HexString()})
	check(t, err)
	svc.added = func(tor *torrent.Torrent) { tor.AddClientPeer(b.client) }
	second, err := svc.Open(t.Context(), Request{InfoHash: b.hash.HexString()})
	check(t, err)
	if resp, _ := get(t, first.URL, nil); resp.StatusCode != http.StatusNotFound {
		t.Errorf("the first torrent still serves: %d", resp.StatusCode)
	}
	if _, body := get(t, second.URL, nil); !bytes.Equal(body, b.files["B.mkv"]) {
		t.Error("the second torrent doesn't serve its file")
	}
}

// The next episode in a pack: another file of the torrent playing plays in
// its place, without fetching the file list again.
func TestOpenSwitchesFilesInATorrent(t *testing.T) {
	sw := seed(t, 64<<10, map[string]int{
		"Show.S01E01.mkv": 256 << 10,
		"Show.S01E02.mkv": 320 << 10,
	})
	svc := engine(t, &sw, on)
	first, err := svc.Open(t.Context(), Request{InfoHash: sw.hash.HexString(), FileName: "Show.S01E01.mkv"})
	check(t, err)
	if _, body := get(t, first.URL, nil); !bytes.Equal(body, sw.files["Show.S01E01.mkv"]) {
		t.Fatal("the first episode doesn't serve")
	}
	svc.mu.Lock()
	before := svc.current
	svc.mu.Unlock()

	second, err := svc.Open(t.Context(), Request{InfoHash: sw.hash.HexString(), FileName: "Show.S01E02.mkv"})
	check(t, err)
	svc.mu.Lock()
	after := svc.current
	svc.mu.Unlock()
	if after != before {
		t.Error("the torrent was opened again")
	}
	if second.URL == first.URL || second.Size != 320<<10 {
		t.Fatalf("got %d bytes at the same link: still the first file", second.Size)
	}
	if _, body := get(t, second.URL, nil); !bytes.Equal(body, sw.files["Show.S01E02.mkv"]) {
		t.Error("the second episode doesn't serve")
	}
	if resp, _ := get(t, first.URL, nil); resp.StatusCode != http.StatusNotFound {
		t.Errorf("the first episode still serves: %d", resp.StatusCode)
	}
	if status := svc.Status(); status.Size != 320<<10 {
		t.Errorf("Status is about a %d-byte file, not the second", status.Size)
	}
}

func TestPick(t *testing.T) {
	files := []fileInfo{
		{"Show/Sample/sample.mkv", 10},
		{"Show/Show.S01E01.mkv", 900},
		{"Show/Show.S01E02.mkv", 1000},
		{"Show/Show.S01E01.en.srt", 5},
	}
	for name, test := range map[string]struct {
		req  Request
		want int
	}{
		"index":                  {Request{FileIdx: ptr(1)}, 1},
		"index and name":         {Request{FileIdx: ptr(1), FileName: "show.s01e01.mkv"}, 1},
		"index off, name":        {Request{FileIdx: ptr(0), FileName: "Show.S01E02.mkv"}, 2},
		"index out of range":     {Request{FileIdx: ptr(9)}, 2},
		"index of a subtitle":    {Request{FileIdx: ptr(3)}, 2},
		"name alone":             {Request{FileName: "Show.S01E01.mkv"}, 1},
		"nothing: largest video": {Request{}, 2},
		"unknown name":           {Request{FileName: "Other.mkv"}, 2},
	} {
		t.Run(name, func(t *testing.T) {
			if got := pick(files, test.req); got != test.want {
				t.Fatalf("pick = %d, want %d", got, test.want)
			}
		})
	}
	if got := pick([]fileInfo{{"notes.txt", 1}}, Request{}); got != -1 {
		t.Errorf("no video: pick = %d", got)
	}
}

func TestTrackersOf(t *testing.T) {
	got := trackersOf([]string{
		"tracker:udp://tracker.example:1337/announce",
		"dht:abcdef",
		"tracker:https://t.example/announce",
		"tracker:javascript:alert(1)",
		"udp://bare.example:80",
	})
	want := []string{"udp://tracker.example:1337/announce", "https://t.example/announce"}
	if fmt.Sprint(got) != fmt.Sprint(want) {
		t.Fatalf("trackers = %v", got)
	}
}

func TestMarshalError(t *testing.T) {
	for err, code := range map[error]string{
		ErrDisabled:                       CodeDisabled,
		ErrInvalid:                        CodeInvalid,
		fmt.Errorf("x: %w", ErrNoPeers):   CodeNoPeers,
		ErrNoFile:                         CodeNoFile,
		errors.New("disk full /home/a/b"): CodeFailed,
	} {
		var got map[string]string
		check(t, json.Unmarshal(MarshalError(err), &got))
		if len(got) != 1 || got["code"] != code {
			t.Errorf("%v: %v", err, got)
		}
	}
}

func check(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
