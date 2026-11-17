package main

// -app measures in the app's own player (#101): internal/player's libmpv
// session in a Wails window, with hardware decoding and the real video
// host, rather than the mpv binary with a null VO. Each sample is one
// episode, picked once, so it's cold. Its session opens with the pick and
// stops after the first frame, as the picker opening /player and leaving
// it does.
//
//	go run ./tools/ttff -app -ids series/tt1190634:1:1,series/tt1190634:1:2 \
//	  -hash 0d1484a8… -mode alternate -look 3s -mbps 50
//
// -mode plain resolves at the pick (what the picker does with "Start cached
// streams sooner" off): its time to first frame is resolve + load. -mode
// ahead resolves first, as the picker does once the ranking settles with the
// setting on, waits -look (the user reading the list), and times only from
// the pick: the load. -mode alternate takes turns, plain first, so the two
// share the network's ups and downs.

import (
	"context"
	"errors"
	"fmt"
	"log"
	"net/http"
	"slices"
	"strings"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/k22i/Peli/internal/player"
	"github.com/k22i/Peli/internal/streams"
)

type appRun struct {
	key, ids, hashes, mode string
	look                   time.Duration
	mbps                   float64
}

type sample struct {
	id, mode         string
	resolve, load    time.Duration
	read             int64
	err              error
	resolvedFromHash string
}

func (r appRun) ttff(s sample) time.Duration {
	if s.mode == "ahead" {
		return s.load
	}
	return s.resolve + s.load
}

func runApp(r appRun) {
	players := player.NewService("0.0.0-ttff")
	app := application.New(application.Options{
		Name:     "Peli ttff",
		Services: []application.Service{application.NewService(players)},
		Assets: application.AssetOptions{Handler: http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
			// The webview over the video is see-through where the player
			// screen is, as in the app.
			_, _ = w.Write([]byte(`<!doctype html><html style="background:transparent"><body></body></html>`))
		})},
		Mac: application.MacOptions{ApplicationShouldTerminateAfterLastWindowClosed: true},
	})
	window := app.Window.NewWithOptions(application.WebviewWindowOptions{
		Title: "Peli ttff", Width: 1280, Height: 720, URL: "/",
		BackgroundColour: application.NewRGBA(0, 0, 0, 0),
	})
	player.UseWindow(players, window)

	ended := make(chan player.Ended, 4)
	app.Event.On(player.EventEnded, func(e *application.CustomEvent) {
		if end, ok := e.Data.(player.Ended); ok {
			select {
			case ended <- end:
			default:
			}
		}
	})

	app.Event.OnApplicationEvent(events.Common.ApplicationStarted, func(*application.ApplicationEvent) {
		go func() {
			defer app.Quit()
			// The window and its webview come up first, as the app's do
			// long before a pick.
			time.Sleep(2 * time.Second)
			samples := r.measure(players, ended)
			r.report(samples)
		}()
	})
	if err := app.Run(); err != nil {
		log.Fatal(err)
	}
}

func (r appRun) measure(players *player.Service, ended chan player.Ended) []sample {
	resolver := streams.NewService("0.0.0-ttff")
	hashes := strings.Split(r.hashes, ",")
	var samples []sample
	n := 0
	for id := range strings.SplitSeq(r.ids, ",") {
		mode := r.mode
		if mode == "alternate" {
			mode = []string{"plain", "ahead"}[n%2]
		}
		n++
		s := sample{id: id, mode: mode}
		list, err := torrentio(r.key, id)
		if err != nil {
			s.err = fmt.Errorf("torrentio: %w", err)
			samples = append(samples, s)
			fmt.Fprintf(stdout, "%s: %v\n", id, s.err)
			continue
		}
		i := slices.IndexFunc(list, func(st stream) bool {
			return slices.ContainsFunc(hashes, func(h string) bool { return strings.Contains(st.URL, "/"+h) })
		})
		if i < 0 {
			// Never another torrent: it would land in the TorBox list.
			s.err = errors.New("no stream from the given packs")
			samples = append(samples, s)
			fmt.Fprintf(stdout, "%s: %v\n", id, s.err)
			continue
		}
		st := list[i]
		for _, h := range hashes {
			if strings.Contains(st.URL, "/"+h) {
				s.resolvedFromHash = h[:8]
			}
		}
		req := streams.Request{URL: st.URL, Headers: st.Headers()}

		var src streams.Source
		resolve := func() error {
			started := time.Now()
			src, err = resolver.Resolve(context.Background(), req)
			s.resolve = time.Since(started)
			return err
		}
		if mode == "ahead" {
			if err := resolve(); err != nil {
				s.err = fmt.Errorf("resolve: %s", streams.MarshalError(err))
			} else {
				time.Sleep(r.look)
			}
		}
		if s.err == nil {
			// The pick.
			started := time.Now()
			if mode == "plain" {
				err = resolve()
			}
			if err != nil {
				s.err = fmt.Errorf("resolve: %s", streams.MarshalError(err))
			} else {
				proxy := newThrottle(src, r.mbps)
				var load time.Duration
				load, s.err = firstFrameInApp(players, ended, src, proxy)
				s.read = proxy.read.Load()
				// Stopped before the line closes, so mpv doesn't reconnect.
				_ = players.Stop()
				_ = proxy.Close()
				if mode == "plain" {
					s.load = time.Since(started) - s.resolve
				} else {
					s.load = load
				}
			}
		}
		_ = players.Stop()
		samples = append(samples, s)
		if s.err != nil {
			fmt.Fprintf(stdout, "%-24s %-5s %s: %v\n", id, mode, s.resolvedFromHash, s.err)
			continue
		}
		fmt.Fprintf(stdout, "%-24s %-5s %s: resolve %4d ms, load %4d ms, %.1f MB read → %4d ms from the pick\n",
			id, mode, s.resolvedFromHash, s.resolve.Milliseconds(), s.load.Milliseconds(),
			float64(s.read)/1e6, r.ttff(s).Milliseconds())
		// Let the session close and the network settle between samples.
		time.Sleep(time.Second)
	}
	return samples
}

// firstFrameInApp loads src (served by proxy) in the player, opening its
// session, and waits for its first frame.
func firstFrameInApp(players *player.Service, ended chan player.Ended, src streams.Source, proxy *throttle) (time.Duration, error) {
	for len(ended) > 0 {
		<-ended
	}
	through := src
	through.URL = proxy.URL
	started := time.Now()
	if err := players.Load(through, player.LoadOptions{SubtitleSize: "medium", Captions: "off"}); err != nil {
		return 0, fmt.Errorf("load: %w", err)
	}
	timeout := time.After(60 * time.Second)
	for {
		select {
		case end := <-ended:
			return 0, fmt.Errorf("ended: %s %s", end.Reason, end.Code)
		case <-timeout:
			return 0, errors.New("no first frame in 60 s")
		case <-time.After(2 * time.Millisecond):
			if st := players.Snapshot(); st.Active && !st.Loading {
				return time.Since(started), nil
			}
		}
	}
}

func (r appRun) report(samples []sample) {
	by := map[string][]time.Duration{}
	failed := 0
	for _, s := range samples {
		if s.err != nil {
			failed++
			continue
		}
		by[s.mode] = append(by[s.mode], r.ttff(s))
	}
	fmt.Fprintf(stdout, "\n%-6s %3s %8s %8s %8s %s\n", "mode", "n", "median", "best", "worst", "≤ 3 s")
	for _, mode := range []string{"plain", "ahead"} {
		list := by[mode]
		if len(list) == 0 {
			continue
		}
		slices.Sort(list)
		under := 0
		for _, d := range list {
			if d <= 3*time.Second {
				under++
			}
		}
		fmt.Fprintf(stdout, "%-6s %3d %8s %8s %8s %d of %d\n", mode, len(list), ms(median(list)), ms(list[0]),
			ms(list[len(list)-1]), under, len(list))
	}
	if failed > 0 {
		fmt.Fprintf(stdout, "%d samples failed\n", failed)
	}
}

func median(sorted []time.Duration) time.Duration {
	n := len(sorted)
	if n%2 == 1 {
		return sorted[n/2]
	}
	return (sorted[n/2-1] + sorted[n/2]) / 2
}

func ms(d time.Duration) string { return fmt.Sprintf("%.2f s", d.Seconds()) }
