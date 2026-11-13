//go:build ios && pelidev

package main

import (
	"context"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"strconv"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
)

// The simulator remote control (build tag pelidev, never in a shipped build):
// there is no Simulator.app or input tool here, so a script drives the app
// through files in $PELI_DEV_DIR (SIMCTL_CHILD_PELI_DEV_DIR).
//
//   - cmd.js, when it appears, runs in the webview and is deleted.
//   - the page answers by fetch("/__dev/out", {method: "POST", body}), which
//     is appended to out.txt next to it.
//   - $PELI_DEV_EMAIL and $PELI_DEV_PASSWORD, when both are set and nobody
//     is signed in, sign in once at launch through Account.SignIn. Neither
//     is ever logged or written anywhere.
//   - $PELI_DEV_GUEST=1 switches to the local Guest profile (no Nuvio
//     account, so playback writes stay on the device), and
//     $PELI_DEV_ADDONS (manifest URLs, comma separated; they may carry a
//     debrid key, so they are never logged) installs addons into it.

func devAssets(next http.Handler) http.Handler {
	dir := os.Getenv("PELI_DEV_DIR")
	if dir == "" {
		return next
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/__dev/out" {
			next.ServeHTTP(w, r)
			return
		}
		body, _ := io.ReadAll(r.Body)
		f, err := os.OpenFile(filepath.Join(dir, "out.txt"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
		if err == nil {
			f.Write(append(body, '\n'))
			f.Close()
		}
		w.WriteHeader(http.StatusNoContent)
	})
}

func devStart(app *application.App, window *application.WebviewWindow, p *peli) {
	dir := os.Getenv("PELI_DEV_DIR")
	if dir == "" {
		return
	}
	// $PELI_DEV_PLAY plays that URL once, a few seconds after launch, with
	// no page involved: the player engine on its own.
	if u := os.Getenv("PELI_DEV_PLAY"); u != "" {
		go func() {
			time.Sleep(8 * time.Second)
			start, _ := strconv.ParseFloat(os.Getenv("PELI_DEV_START"), 64)
			err := p.players.Load(streams.Source{URL: u}, playback.LoadOptions{Start: start, Captions: "on", SubtitleLanguage: "en", AudioLanguages: []string{"en"}})
			log.Printf("dev play: %v", err)
			// A seek 120 s on, and whether it landed: for the coverage notes.
			time.Sleep(20 * time.Second)
			want := p.players.Snapshot().Position + 120
			at := time.Now()
			err = p.players.Seek(want)
			for i := 0; i < 40 && p.players.Snapshot().Loading; i++ {
				time.Sleep(250 * time.Millisecond)
			}
			time.Sleep(3 * time.Second)
			st := p.players.Snapshot()
			log.Printf("dev seek: err=%v want=%.0f got=%.0f settled=%dms paused=%v", err, want, st.Position, time.Since(at).Milliseconds()-3000, st.Paused)
		}()
	}
	if os.Getenv("PELI_DEV_GUEST") == "1" {
		go func() {
			time.Sleep(3 * time.Second) // the store opens with the services
			devGuest(p)
		}()
	}
	if email, password := os.Getenv("PELI_DEV_EMAIL"), os.Getenv("PELI_DEV_PASSWORD"); email != "" && password != "" {
		go func() {
			time.Sleep(3 * time.Second)
			if _, err := p.accounts.SignIn(context.Background(), email, password); err != nil {
				log.Printf("dev sign-in failed") // never the error: it may echo the email
			} else {
				log.Printf("dev sign-in done")
			}
		}()
	}
	go func() {
		cmd := filepath.Join(dir, "cmd.js")
		for {
			time.Sleep(500 * time.Millisecond)
			js, err := os.ReadFile(cmd)
			if err != nil {
				continue
			}
			os.Remove(cmd)
			window.ExecJS(string(js))
		}
	}()
}

func devGuest(p *peli) {
	if _, err := p.db.SwitchToGuest(); err != nil {
		log.Printf("dev guest failed: %v", err)
		return
	}
	st := store.Opened(p.db)
	prof, err := st.CurrentProfile()
	if err != nil {
		log.Printf("dev guest: no profile")
		return
	}
	for _, u := range strings.Split(os.Getenv("PELI_DEV_ADDONS"), ",") {
		if u = strings.TrimSpace(u); u == "" {
			continue
		}
		if err := st.InstallAddon(prof.ID, store.Addon{URL: u, Enabled: true}); err != nil {
			log.Printf("dev addon not installed") // never the URL
		}
	}
	log.Printf("dev guest ready")
}
