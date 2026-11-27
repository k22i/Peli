package diagnostics

import (
	"net/url"
	"testing"
	"time"
)

// sample is one watchdog tick, with the app in front and browsing.
func sample(w *watchdog, mean uint8, now time.Time) (Action, int, bool) {
	return w.tick(true, mean, true, false, "/home", now)
}

func TestWatchdogCountsBlankRuns(t *testing.T) {
	w := &watchdog{}
	now := time.Now()
	w.sampleContent(t, now)
	for range blankRun - 1 {
		if _, _, fire := sample(w, 0, now); fire {
			t.Fatalf("fired before %d blanks", blankRun)
		}
	}
	action, n, fire := sample(w, 0, now)
	if !fire || action != Reload || n != 1 {
		t.Fatalf("three blanks: fire=%v action=%v n=%d, want Reload n=1", fire, action, n)
	}
	// The run starts over after a recovery.
	for range blankRun - 1 {
		if _, _, fire := sample(w, 0, now); fire {
			t.Fatal("fired on the samples after a recovery")
		}
	}
}

// sampleContent shows the watchdog a page that paints, arming it.
func (w *watchdog) sampleContent(t *testing.T, now time.Time) {
	t.Helper()
	if _, _, fire := sample(w, blankMean, now); fire {
		t.Fatal("content sample fired")
	}
}

func TestWatchdogStaysInertWithoutContent(t *testing.T) {
	w := &watchdog{}
	now := time.Now()
	// Pixels the watchdog cannot read: black even while the page paints.
	// It never arms, and says so once.
	for i := range inertAfter + blankRun {
		if _, _, fire := sample(w, 0, now); fire {
			t.Fatalf("fired at sample %d without ever seeing content", i+1)
		}
	}
	if !w.inertWarned {
		t.Fatal("the watchdog never said its pixels are unreadable")
	}
	// Content read once after all that black arms it, and it fires on the
	// next full blank run.
	w.sampleContent(t, now)
	for range blankRun - 1 {
		sample(w, 0, now)
	}
	if _, _, fire := sample(w, 0, now); !fire {
		t.Fatal("did not fire after content was finally seen")
	}
}

func TestWatchdogRunResetsOnContent(t *testing.T) {
	w := &watchdog{}
	now := time.Now()
	w.sampleContent(t, now)
	for range blankRun - 1 {
		sample(w, 0, now)
	}
	w.sampleContent(t, now) // the run starts over
	for range blankRun - 1 {
		if _, _, fire := sample(w, 0, now); fire {
			t.Fatal("fired on a run that content reset")
		}
	}
	if _, _, fire := sample(w, 0, now); !fire {
		t.Fatal("did not fire on the full run after the reset")
	}
}

func TestWatchdogSkipsWhileAbsentBusyOrPlaying(t *testing.T) {
	for _, tc := range []struct {
		name     string
		sampled  bool
		isActive bool
		busy     bool
		route    string
	}{
		{"no webview yet", false, true, false, "/home"},
		{"app in the background", true, false, false, "/home"},
		{"video playing", true, true, true, "/home"},
		{"player route", true, true, false, "/player"},
		{"player route with a query", true, true, false, "/player?x=1"},
	} {
		w := &watchdog{}
		now := time.Now()
		// One content sample arms it; then the skip case runs blankRun
		// times: none of them may fire or count towards the run.
		w.sampleContent(t, now)
		for range blankRun {
			if _, _, fire := w.tick(tc.sampled, 0, tc.isActive, tc.busy, tc.route, now); fire {
				t.Fatalf("%s: fired", tc.name)
			}
		}
		// The run was reset: blankRun blanks in the browse UI fire again.
		var fire bool
		for range blankRun {
			_, _, fire = sample(w, 0, now)
		}
		if !fire {
			t.Fatalf("%s: the run was not reset by the skip", tc.name)
		}
	}
}

func TestWatchdogEscalatesWithinTheWindow(t *testing.T) {
	w := &watchdog{}
	now := time.Now()
	w.sampleContent(t, now)
	recover := func(at time.Time) (Action, int) {
		var action Action
		var n int
		for range blankRun - 1 {
			sample(w, 0, at)
		}
		action, n, _ = sample(w, 0, at)
		return action, n
	}
	if a, n := recover(now); a != Reload || n != 1 {
		t.Fatalf("first recovery: action=%v n=%d, want Reload 1", a, n)
	}
	if a, n := recover(now.Add(2 * time.Minute)); a != Reload || n != 2 {
		t.Fatalf("second recovery: action=%v n=%d, want Reload 2", a, n)
	}
	if a, n := recover(now.Add(4 * time.Minute)); a != ReloadHome || n != 3 {
		t.Fatalf("third recovery: action=%v n=%d, want ReloadHome 3", a, n)
	}
	if a, n := recover(now.Add(6 * time.Minute)); a != ErrorPage || n != 4 {
		t.Fatalf("fourth recovery: action=%v n=%d, want ErrorPage 4", a, n)
	}
	// No recovery is left inside the window at 16: a plain reload again,
	// not another error page.
	if a, n := recover(now.Add(16 * time.Minute)); a != Reload || n != 1 {
		t.Fatalf("recovery after the window: action=%v n=%d, want Reload 1", a, n)
	}
}

// A Platform whose LoadWebview records the address, for RecoverWebview.
type recordingLoader struct {
	fakePlatform
	loaded []string
}

func (p *recordingLoader) LoadWebview(url string)       { p.loaded = append(p.loaded, url) }
func (p *recordingLoader) MakeWebviewTransparent() bool { return true }

func TestRecoverWebviewReloadsTheRoute(t *testing.T) {
	p := &recordingLoader{}
	s := New(Options{Dir: t.TempDir(), Ring: NewRing(4), Platform: p})
	Start(s, time.Now())
	s.SetRoute("/title/movie/tt123")
	RecoverWebview(s, "test")
	if len(p.loaded) != 1 {
		t.Fatalf("loaded %d addresses, want 1", len(p.loaded))
	}
	u, err := url.Parse(p.loaded[0])
	if err != nil {
		t.Fatalf("loaded %q: %v", p.loaded[0], err)
	}
	if u.RawQuery != RecoveredParam+"=reload" {
		t.Errorf("query %q, want the reload marker", u.RawQuery)
	}
	if u.Fragment != "/title/movie/tt123" {
		t.Errorf("route %q, want the route the page was on", u.Fragment)
	}
}
