package diagnostics

import (
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"
)

// The webview can stop painting with nothing else dying: on iPadOS 27 an
// M-series iPad composites nothing of the page while its DOM, its JS, its
// touch input and every process stay alive (the black screen, seen on a
// real device: a full-screen element at the maximum z-index drew zero
// pixels while the inspector ran the page's JS). No content-process kill
// fires, so the #127 recovery never runs and the screen stays black until
// a navigation forces WebKit to composite again.
//
// The watchdog samples what the webview shows while the app browses: a
// blankRun of dead-black samples in a row recover the webview by the same
// actions as a kill. It stays inert until a sample has once seen the page,
// so a webview whose pixels a device cannot read (the sample always black)
// can never trigger a recovery.

const (
	// watchEvery is how often the webview is sampled. 30 s makes a blank
	// noticeable within a minute and a half, without sampling in a scroll.
	watchEvery = 30 * time.Second
	// blankMean is the mean luma (0-255) below which a sample counts as
	// blank. The shell paints #0e0d0c everywhere, a mean of about 13; a
	// page that stopped painting shows the black behind the webview: 0.
	blankMean = 4
	// blankRun is the consecutive blank samples that recover the webview:
	// three, so a moment between layers (a sheet opening, a snapshot of a
	// page mid-navigation) is never mistaken for the real thing.
	blankRun = 3
	// blankWindow is how far back recoveries count towards giving up.
	blankWindow = 10 * time.Minute
	// blankHome is the recoveries within blankWindow that load Home
	// instead (the route itself may be what stops painting), blankError
	// the number that shows the error page: reloading would loop.
	blankHome  = 3
	blankError = 4
	// inertAfter is the samples after which a watchdog that has never seen
	// content says so once: on that device the sample reads black even
	// when the page paints, and the watchdog can never help.
	inertAfter = 10
)

// WatchOptions wires the watchdog to the platform (main_ios.go).
type WatchOptions struct {
	// Sample is the webview's pixels right now: the mean luma 0-255 of a
	// small drawing of it, ok false when there is no webview yet.
	Sample func() (mean uint8, ok bool)
	// Busy reports the video engine showing video now: the player sits
	// over the video layer by design, so its black is legitimate.
	Busy func() bool
}

// Watch starts the webview watchdog. It runs for the app's lifetime and
// only on iOS: the desktop's webview has never been seen to stop painting.
func Watch(s *Service, opts WatchOptions) {
	if opts.Sample == nil {
		return
	}
	w := &watchdog{s: s, opts: opts}
	go w.loop()
}

type watchdog struct {
	s    *Service
	opts WatchOptions

	mu          sync.Mutex
	sawContent  bool        // a sample has seen the page paint
	blanks      int         // consecutive blank samples
	events      []time.Time // recoveries, for giving up
	inertWarned bool        // the "pixels unreadable" line has been logged
}

// loop samples the webview on every tick and recovers it when the page has
// stopped painting. Until the webview is there, each tick first tries to
// make it see-through once (the player no longer has to flip its opacity
// mid-session, the moment the black screen was most assured).
func (w *watchdog) loop() {
	t := time.NewTicker(watchEvery)
	defer t.Stop()
	for now := range t.C {
		if !w.s.makeWebviewTransparent() {
			continue // no webview yet
		}
		mean, ok := w.opts.Sample()
		busy := w.opts.Busy != nil && w.opts.Busy()
		action, n, fire := w.tick(ok, mean, active.Load(), busy, Route(w.s), now)
		if !fire {
			continue
		}
		w.recover(action, n)
	}
}

// tick is one sample's verdict, pure so it can be tested: fire is true
// when the page has stopped painting and the webview should be recovered
// with action (n is the recoveries within blankWindow, this one included).
func (w *watchdog) tick(sampled bool, mean uint8, isActive, busy bool, route string, now time.Time) (action Action, n int, fire bool) {
	w.mu.Lock()
	defer w.mu.Unlock()
	// Nothing to judge: no webview yet, the app is not the one in front,
	// or the video is up. A run of blanks does not survive any of these.
	if !sampled || !isActive || busy || strings.HasPrefix(route, "/player") {
		w.blanks = 0
		return 0, 0, false
	}
	if mean >= blankMean {
		w.sawContent = true
		w.blanks = 0
		return 0, 0, false
	}
	w.blanks++
	if !w.sawContent {
		if w.blanks == inertAfter && !w.inertWarned {
			w.inertWarned = true
			slog.Warn("webview: watchdog cannot read the page's pixels; staying inert")
		}
		return 0, 0, false
	}
	if w.blanks < blankRun {
		return 0, 0, false
	}
	w.blanks = 0
	kept := w.events[:0]
	for _, t := range w.events {
		if now.Sub(t) < blankWindow {
			kept = append(kept, t)
		}
	}
	w.events = append(kept, now)
	switch n := len(w.events); {
	case n >= blankError:
		return ErrorPage, n, true
	case n >= blankHome:
		return ReloadHome, n, true
	default:
		return Reload, n, true
	}
}

// recover loads what action says, logged and flushed like a kill so the
// ring tells the story on the next device run.
func (w *watchdog) recover(action Action, n int) {
	route := Route(w.s)
	url := ""
	if action != ErrorPage {
		url = recoveryURL("", route, action)
	}
	slog.Error(fmt.Sprintf("webview: blank, the page stopped painting (n=%d)", n),
		"route", route, "action", actionName(action))
	logMemory(w.s, "blank")
	Flush(w.s)
	w.s.loadWebview(url)
}
