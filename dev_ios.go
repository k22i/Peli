//go:build ios && pelidev

package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"net/http"
	"os"
	"path/filepath"
	"time"

	"strconv"
	"strings"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/appinfo"
	"github.com/k22i/Peli/internal/diagnostics"
	"github.com/k22i/Peli/internal/iosplayer"
	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/safego"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
	"github.com/k22i/Peli/internal/syncer"
	"github.com/k22i/Peli/internal/tracking"
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
//   - play, when it appears, holds a JSON object {url, start, contentId,
//     contentType, videoId, season, episode, title, name, year, ids} and is
//     deleted: that stream plays as the profile in use's Watching file, with
//     no page involved (the URL is never logged).
//   - ctl holds one of pause, resume, seek N, stop, turn left/right/portrait
//     (as the motion sensor would; the simulator has none) or state (a snapshot of
//     the player is written to state.txt) and is deleted.
//   - audio, when it appears, holds interrupt, ended, ended-resume or route
//     and is deleted: the notification iOS posts for that event is posted,
//     which drives the player's handlers (iosplayer.DevAudioEvent).

// The rig's crash commands (#127) work, and Settings › About shows them: on a
// device, where there is no cmd.js, that is how they are run.
func init() { diagnostics.DevBuild = true }

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

func devStart(app *application.App, window *application.WebviewWindow, p *peli, engine *iosplayer.Engine) {
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
	safego.Go("pelidev: files", func() { devFiles(dir, p) })
	safego.Go("pelidev: audio", func() {
		audio := filepath.Join(dir, "audio")
		for {
			time.Sleep(500 * time.Millisecond)
			data, err := os.ReadFile(audio)
			if err != nil {
				continue
			}
			os.Remove(audio)
			switch strings.TrimSpace(string(data)) {
			case "interrupt":
				iosplayer.DevAudioEvent(1, false)
			case "ended":
				iosplayer.DevAudioEvent(2, false)
			case "ended-resume":
				iosplayer.DevAudioEvent(2, true)
			case "route":
				iosplayer.DevAudioEvent(3, false)
			}
		}
	})
	safego.Go("pelidev: cmd.js", func() {
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
	})
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

// devLog appends a line to log.txt in the dev dir: what the rig's scripts
// read back instead of the console.
func devLog(format string, args ...any) {
	dir := os.Getenv("PELI_DEV_DIR")
	if dir == "" {
		return
	}
	f, err := os.OpenFile(filepath.Join(dir, "log.txt"), os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	fmt.Fprintf(f, "%s %s\n", time.Now().Format("15:04:05.000"), fmt.Sprintf(format, args...))
}

// devFiles runs the play and ctl files.
func devFiles(dir string, p *peli) {
	for {
		time.Sleep(300 * time.Millisecond)
		if data, err := os.ReadFile(filepath.Join(dir, "play")); err == nil {
			os.Remove(filepath.Join(dir, "play"))
			var req struct {
				URL                             string
				Start                           float64
				ContentID, ContentType, VideoID string
				Season, Episode                 *int
				Title, Name                     string
				Year                            int
				IDs                             map[string]string
			}
			if err := json.Unmarshal(data, &req); err != nil {
				devLog("play: bad request")
				continue
			}
			profile, ok, err := store.Opened(p.db).ProfileInUse()
			if err != nil || !ok {
				devLog("play: no profile in use")
				continue
			}
			w := playback.Watching{ProfileID: profile.ID, ContentID: req.ContentID, ContentType: req.ContentType, VideoID: req.VideoID,
				Season: req.Season, Episode: req.Episode, Title: req.Title, Name: req.Name, Year: req.Year, IDs: req.IDs}
			err = p.players.Load(streams.Source{URL: req.URL}, playback.LoadOptions{Start: req.Start, Watching: &w, Captions: "off"})
			devLog("play: %v", err)
		}
		if data, err := os.ReadFile(filepath.Join(dir, "ctl")); err == nil {
			os.Remove(filepath.Join(dir, "ctl"))
			f := strings.Fields(string(data))
			if len(f) == 0 {
				continue
			}
			var err error
			switch f[0] {
			case "pause":
				err = p.players.SetPaused(true)
			case "resume":
				err = p.players.SetPaused(false)
			case "stop":
				err = p.players.Stop()
			case "turn":
				// What the motion sensor would ask for (the simulator has none).
				side := iosplayer.Portrait
				if len(f) > 1 && f[1] == "left" {
					side = iosplayer.LandscapeLeft
				} else if len(f) > 1 && f[1] == "right" {
					side = iosplayer.LandscapeRight
				}
				turnTo(side)
			case "seek":
				if len(f) > 1 {
					v, _ := strconv.ParseFloat(f[1], 64)
					err = p.players.Seek(v)
				}
			case "simkl-connect":
				// Against the rig's fake: needs approve-simkl dropped in the dev dir.
				profile, _, _ := store.Opened(p.db).ProfileInUse()
				go func() {
					if _, err := p.trackers.StartSimkl(context.Background(), profile.ID); err != nil {
						devLog("simkl-connect start: %v", err)
						return
					}
					c, err := p.trackers.WaitSimkl(context.Background())
					devLog("simkl-connect: connected=%v err=%v", c.Simkl != nil, err)
				}()
			case "ani-connect":
				// ani-connect <page>: the rig's stand-in for AniList's approval page.
				profile, _, _ := store.Opened(p.db).ProfileInUse()
				if _, err := p.trackers.StartAniList(context.Background(), profile.ID); err != nil {
					devLog("ani-connect start: %v", err)
					break
				}
				err = appinfo.Service{}.OpenSignInPage(f[1])
				devLog("ani-connect sheet: %v", err)
				go func() {
					c, err := p.trackers.WaitAniList(context.Background())
					appinfo.Service{}.CloseSignInPage()
					devLog("ani-connect: connected=%v err=%v", c.AniList != nil, err)
				}()
			case "addon":
				profile, _, _ := store.Opened(p.db).ProfileInUse()
				err = store.Opened(p.db).InstallAddon(profile.ID, store.Addon{URL: f[1], Enabled: true})
			case "tracker":
				// tracker <get|none> <type> <contentId> <name> <year>: a title's
				// tracker status, or "none" to remove it from the lists (and the
				// history), which is the undo for a live scrobble.
				profile, _, _ := store.Opened(p.db).ProfileInUse()
				year, _ := strconv.Atoi(f[5])
				ref := tracking.TitleRef{Type: f[2], ID: f[3], Name: f[4], Year: year, IDs: map[string]string{"imdb": f[3]}}
				var tt tracking.TitleTracking
				if f[1] == "none" {
					tt, err = p.trackers.SetStatus(context.Background(), profile.ID, ref, "none")
				} else {
					tt, err = p.trackers.TitleStatus(context.Background(), profile.ID, ref)
				}
				devLog("tracker %s %s: status=%s rating=%d services=%v queued=%v", f[1], f[3], tt.Status, tt.Rating, tt.Services, tt.Queued)
			case "simkl-code":
				// Starts the live SIMKL sign-in and logs the code and page to approve.
				profile, _, _ := store.Opened(p.db).ProfileInUse()
				code, cerr := p.trackers.StartSimkl(context.Background(), profile.ID)
				devLog("simkl-code: %s %s err=%v", code.Code, code.PageURL, cerr)
				if cerr == nil {
					go func() {
						c, err := p.trackers.WaitSimkl(context.Background())
						devLog("simkl-code done: connected=%v err=%v", c.Simkl != nil, err)
					}()
				}
			case "check":
				// check <contentId>: what the store holds for the title, the
				// outbox and the trackers; no values that identify the account.
				db := store.Opened(p.db)
				profile, _, _ := db.ProfileInUse()
				pending, _ := db.Pending(profile.ID)
				watched, _ := db.TitleWatched(profile.ID, f[1])
				progress, _ := db.ContinueWatching(profile.ID)
				n := 0
				for _, e := range progress {
					if e.ContentID == f[1] {
						n++
					}
				}
				c, _ := p.trackers.Status(profile.ID)
				devLog("check %s: pending=%d watched=%d continue=%d simkl=%v anilist=%v", f[1], len(pending), len(watched), n, c.Simkl != nil, c.AniList != nil)
			case "pull":
				_, err = syncer.PullerOf(p.sync).PullNow(context.Background())
			case "undo":
				// undo <contentId> <season> <episode>: unmark watched and drop the progress.
				db := store.Opened(p.db)
				profile, _, _ := db.ProfileInUse()
				// "-" for a film (no season or episode).
				var sp, ep *int
				if f[2] != "-" {
					a, _ := strconv.Atoi(f[2])
					b, _ := strconv.Atoi(f[3])
					sp, ep = &a, &b
				}
				e1 := db.UnmarkWatched(profile.ID, f[1], sp, ep)
				e2 := db.RemoveProgress(profile.ID, store.ProgressKey(f[1], sp, ep))
				syncer.PusherOf(p.sync).Background(context.Background())
				devLog("undo: unmark=%v progress=%v", e1, e2)
			case "disconnect":
				profile, _, _ := store.Opened(p.db).ProfileInUse()
				_, e1 := p.trackers.DisconnectSimkl(context.Background(), profile.ID)
				_, e2 := p.trackers.DisconnectAniList(profile.ID)
				devLog("disconnect: simkl=%v anilist=%v", e1, e2)
			case "state":
				st := p.players.Snapshot()
				devLog("state: active=%v paused=%v loading=%v position=%.1f duration=%.1f", st.Active, st.Paused, st.Loading, st.Position, st.Duration)
			}
			devLog("ctl %s: %v", f[0], err)
		}
	}
}
