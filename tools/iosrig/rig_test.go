//go:build rig

// Package iosrig is the host side of the simulator runs (ADR-0059): fake
// Nuvio, SIMKL and AniList servers and a media server on the Mac's loopback,
// driven by files so a script can take Nuvio offline without touching the
// Mac's network. Run it with
//
//	RIG_DIR=<dir> RIG_MEDIA=<dir with video files> go test -tags rig -run TestRig -timeout 4h ./tools/iosrig
//
// It writes env.txt (the URLs for the app's PELI_NUVIO_URL, PELI_SIMKL_URL
// and PELI_ANILIST_URL) and stops when stop appears in RIG_DIR. The files it
// watches in RIG_DIR:
//
//	offline        present: Nuvio drops every connection; absent: it answers.
//	simkl-down     present: SIMKL answers 503.
//	dump           when it appears, dump.txt gets what the fakes saw; deleted.
//	approve-simkl  approves SIMKL's pending device code; deleted.
//
// A test, not a program, because the fakes take a testing.TB.
package iosrig

import (
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/k22i/Peli/internal/nuvio/nuviotest"
	"github.com/k22i/Peli/internal/simkl/simkltest"
)

const email = "rig@example.com"

func TestRig(t *testing.T) {
	dir := os.Getenv("RIG_DIR")
	if dir == "" {
		t.Skip("RIG_DIR not set")
	}
	nuvio := nuviotest.NewServer(t)
	nuvio.SetProfiles(t, email, `[{"profile_index":1,"name":"Rig","avatar_color_hex":"#33B5E0"}]`)
	sim := simkltest.New(t)
	ani := newAniList(t)

	// Media on a fixed port, so a file URL is stable across rig restarts.
	mux := http.NewServeMux()
	mux.Handle("/", http.FileServer(http.Dir(os.Getenv("RIG_MEDIA"))))
	// A stream addon for every movie and episode: the clip, served locally.
	mux.HandleFunc("/addon/manifest.json", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		io.WriteString(w, `{"id":"rig.streams","version":"1.0.0","name":"Rig streams","description":"local clip","resources":["stream"],"types":["movie","series"],"idPrefixes":["tt"],"catalogs":[]}`)
	})
	mux.HandleFunc("/addon/stream/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		io.WriteString(w, `{"streams":[{"name":"Rig","title":"clip.mp4 1080p WEB-DL","url":"http://127.0.0.1:47831/clip.mp4"}]}`)
	})
	media := httptest.NewUnstartedServer(mux)
	l, err := net.Listen("tcp", "127.0.0.1:47831")
	if err != nil {
		t.Fatal(err)
	}
	media.Listener.Close()
	media.Listener = l
	media.Start()
	t.Cleanup(media.Close)

	env := fmt.Sprintf("PELI_NUVIO_URL=%s\nPELI_SIMKL_URL=%s\nPELI_ANILIST_URL=%s\nMEDIA=%s\nEMAIL=%s\nPASSWORD=%s\n",
		nuvio.URL, sim.URL, ani.URL, media.URL, email, nuviotest.Password)
	if err := os.WriteFile(filepath.Join(dir, "env.txt"), []byte(env), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Logf("rig up: nuvio %s simkl %s anilist %s media %s", nuvio.URL, sim.URL, ani.URL, media.URL)

	has := func(name string) bool { _, err := os.Stat(filepath.Join(dir, name)); return err == nil }
	for !has("stop") {
		time.Sleep(200 * time.Millisecond)
		nuvio.Offline.Store(has("offline"))
		sim.Set(func(s *simkltest.Server) { s.Down = has("simkl-down") })
		if has("approve-simkl") {
			os.Remove(filepath.Join(dir, "approve-simkl"))
			sim.Set(func(s *simkltest.Server) { s.Approved = true })
		}
		if has("dump") {
			os.Remove(filepath.Join(dir, "dump"))
			var b strings.Builder
			for _, surface := range []string{"progress", "watched", "library"} {
				rows := nuvio.Rows(email, 1, surface)
				data, _ := json.Marshal(rows)
				fmt.Fprintf(&b, "nuvio %s: %s\n", surface, data)
			}
			fmt.Fprintf(&b, "nuvio pushes: progress=%d\n", nuvio.Pushes("sync_push_watch_progress"))
			for _, c := range sim.Calls() {
				fmt.Fprintf(&b, "simkl scrobble: action=%s progress=%.1f min=%d\n", c.Action, c.Progress, c.MinProgress)
			}
			h, _ := json.Marshal(sim.Histories())
			fmt.Fprintf(&b, "simkl history: %s\n", h)
			fmt.Fprintf(&b, "anilist: %s\n", strings.Join(ani.log(), " | "))
			os.WriteFile(filepath.Join(dir, "dump.txt"), []byte(b.String()), 0o644)
		}
	}
}

// aniList is a fake AniList GraphQL endpoint that accepts any bearer token
// and keeps one list.
type aniList struct {
	*httptest.Server
	mu      sync.Mutex
	entries map[int]map[string]any
	saved   []string
}

func newAniList(t *testing.T) *aniList {
	a := &aniList{entries: map[int]map[string]any{}}
	a.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodGet && r.URL.Path == "/authorize" {
			// What AniList does after the user approves: the browser goes to
			// the redirect page Peli serves, with the token in the fragment.
			w.Header().Set("Content-Type", "text/html")
			io.WriteString(w, `<!doctype html><meta name=viewport content="width=device-width"><body style="font:20px sans-serif;padding:2em"><p>Fake AniList: approving…</p><script>setTimeout(()=>{location.href="http://127.0.0.1:47613/anilist#access_token=rig-token&token_type=Bearer"},9000)</script>`)
			return
		}
		a.mu.Lock()
		defer a.mu.Unlock()
		var req struct {
			Query     string         `json:"query"`
			Variables map[string]any `json:"variables"`
		}
		data, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(data, &req)
		var answer any
		media, _ := req.Variables["id"].(float64)
		switch {
		case strings.Contains(req.Query, "Viewer"):
			answer = map[string]any{"Viewer": map[string]any{"id": 7, "name": "rig"}}
		case strings.Contains(req.Query, "DeleteMediaListEntry"):
			a.saved = append(a.saved, fmt.Sprintf("delete:%d", int(media)))
			answer = map[string]any{"DeleteMediaListEntry": map[string]any{"deleted": true}}
		case strings.Contains(req.Query, "SaveMediaListEntry"):
			id := int(media)
			e := a.entries[id]
			if e == nil {
				e = map[string]any{"id": 1000 + id, "status": "PLANNING", "progress": 0}
				a.entries[id] = e
			}
			for _, k := range []string{"progress", "status", "score"} {
				if v, ok := req.Variables[k]; ok {
					e[k] = v
				}
			}
			a.saved = append(a.saved, fmt.Sprintf("save:%d:%v:%v", id, e["progress"], e["status"]))
			answer = map[string]any{"SaveMediaListEntry": map[string]any{"id": 1}}
		case strings.Contains(req.Query, "MediaListCollection"):
			answer = map[string]any{"MediaListCollection": map[string]any{"lists": []any{}}}
		case strings.Contains(req.Query, "Media("):
			answer = map[string]any{"Media": map[string]any{"id": int(media), "episodes": 28, "format": "TV", "mediaListEntry": a.entries[int(media)]}}
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"data": answer})
	}))
	t.Cleanup(a.Close)
	return a
}

func (a *aniList) log() []string {
	a.mu.Lock()
	defer a.mu.Unlock()
	return append([]string(nil), a.saved...)
}
