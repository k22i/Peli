// Package diagnostics is what lets Peli on a phone show why it broke (#127):
// the last log lines kept in memory and on disk, Go's crash files, the
// frontend's errors, memory breadcrumbs, and the loop guard for reloading
// the webview after iOS kills its content process.
//
// The bound methods (Service) are the frontend's: Report, SetRoute,
// ShareLogs, LastCrash, Info and DevCrash. What the platform calls is plain
// functions (Flush, Terminated, MemoryWarning…), so Wails doesn't bind them.
package diagnostics

import (
	"cmp"
	"errors"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"strings"
	"sync"
	"time"

	"github.com/k22i/Peli/internal/appinfo"
	"github.com/k22i/Peli/internal/safego"
)

// EventMemoryWarning is emitted when iOS says memory is low: the frontend
// drops its unused queries and cached artwork.
const EventMemoryWarning = "diagnostics:memory-warning"

// DevBuild is true in a build with the simulator and device rig (build tag
// pelidev, dev_ios.go): the crash commands work and Settings shows them.
var DevBuild = false

// Platform is what only the native side can do. Desktop has a twin (no
// share sheet: it reveals the logs folder).
type Platform interface {
	// Share offers the files to send: the iOS share sheet.
	Share(paths []string) error
	// Memory is os_proc_available_memory() and the process footprint
	// (task_vm_info.phys_footprint), in bytes; ok is false off iOS.
	Memory() (available, footprint uint64, ok bool)
	// Device is a short line for the logs' header: OS version and model.
	Device() string
}

// Service is the bound Diagnostics service.
type Service struct {
	dir      string // the app's data dir; logs/ and crash/ go in it
	ring     *Ring  // nil when logs aren't kept (the desktop)
	platform Platform
	emit     func(string)

	mu      sync.Mutex
	route   string
	crash   *Crash
	reports []time.Time

	recovery recovery
}

// Options are what New needs.
type Options struct {
	// Dir is the data directory (the database's).
	Dir string
	// Ring holds the log lines (Install's), or nil to keep none.
	Ring     *Ring
	Platform Platform
	// Emit sends an event to the frontend (Wails' app.Event.Emit); may be nil.
	Emit func(name string)
}

// New makes the service. It writes nothing until Start or a call.
func New(o Options) *Service {
	return &Service{dir: o.Dir, ring: o.Ring, platform: cmp.Or[Platform](o.Platform, nonePlatform{}), emit: o.Emit}
}

// Install makes a ring, sets slog's default (and so the log package's) to
// write to stderr and to it, and returns it. Call it first thing in main.
func Install() *Ring {
	ring := NewRing(RingLines)
	slog.SetDefault(slog.New(NewHandler(os.Stderr, ring)))
	return ring
}

func (s *Service) logsDir() string  { return filepath.Join(s.dir, "logs") }
func (s *Service) crashDir() string { return filepath.Join(s.dir, "crash") }

// LastLog is where the ring is written.
func LastLog(s *Service) string { return filepath.Join(s.logsDir(), "last.txt") }

// previousLog is the last run's log, moved aside at launch.
func previousLog(s *Service) string { return filepath.Join(s.logsDir(), "previous.txt") }

// Start is the launch: the last run's log is kept as previous.txt, Go's
// crash output goes to this run's crash file, and a recovered panic writes
// the log out. A previous run that crashed is logged.
func Start(s *Service, now time.Time) {
	if s.ring != nil {
		if err := os.MkdirAll(s.logsDir(), 0o755); err == nil {
			_ = os.Rename(LastLog(s), previousLog(s))
		}
	}
	f, last, err := openCrashFile(s.crashDir(), now)
	if err != nil {
		slog.Warn("diagnostics: no crash file", "error", err)
	} else if err := debug.SetCrashOutput(f, debug.CrashOptions{}); err != nil {
		slog.Warn("diagnostics: crash output not set", "error", err)
	}
	if f != nil {
		f.Close() // SetCrashOutput holds its own duplicate
	}
	s.mu.Lock()
	s.crash = last
	s.mu.Unlock()
	if last != nil && last.Previous {
		slog.Warn("previous run crashed", "file", last.Name, "at", last.Time.Format(time.RFC3339))
	}
	safego.SetHandler(func(string, any, []byte) { Flush(s) })
}

// Flush writes the ring to logs/last.txt: on WillResignActive, a recovered
// panic, every memory breadcrumb and before sharing.
func Flush(s *Service) {
	if s.ring == nil {
		return
	}
	if err := s.ring.WriteFile(LastLog(s)); err != nil {
		slog.Warn("diagnostics: log not written", "error", err)
	}
}

// Report logs an error from the frontend (kind is "js", "rejection" or
// "render"), with its stack. At most reportsPerMinute a minute get through:
// the frontend limits them too, this is the backstop.
func (s *Service) Report(kind, message, stack string) {
	if !s.allowReport(time.Now()) {
		return
	}
	slog.Error("frontend error", "kind", clip(kind, 32), "message", clip(message, 2000), "stack", clip(stack, 8000))
}

const reportsPerMinute = 20

func (s *Service) allowReport(now time.Time) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	kept := s.reports[:0]
	for _, t := range s.reports {
		if now.Sub(t) < time.Minute {
			kept = append(kept, t)
		}
	}
	s.reports = kept
	if len(s.reports) >= reportsPerMinute {
		return false
	}
	s.reports = append(s.reports, now)
	return true
}

// SetRoute is the route to come back to if the webview dies: the frontend
// saves it on every navigation (for the player, the title it came from).
func (s *Service) SetRoute(route string) {
	s.mu.Lock()
	s.route = clip(route, 2048)
	s.mu.Unlock()
}

// Route is the route last saved.
func Route(s *Service) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.route
}

// LastCrash is the newest crash file kept, or nil.
func (s *Service) LastCrash() *Crash {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.crash == nil {
		return nil
	}
	c := *s.crash
	return &c
}

// Info is what Settings needs to know about this build.
type Info struct {
	// Dev is a build with the rig's crash commands (pelidev).
	Dev bool `json:"dev"`
	// Logs is whether this build keeps logs to share (iOS).
	Logs bool `json:"logs"`
}

// Info says what this build has.
func (s *Service) Info() Info { return Info{Dev: DevBuild, Logs: s.ring != nil} }

// ShareLogs offers the logs: the iOS share sheet with a header (the build,
// the device, free memory) and this run's log in one file, the last run's
// log, and the newest crash file. The desktop reveals the logs folder.
func (s *Service) ShareLogs() error {
	Flush(s)
	if err := os.MkdirAll(s.logsDir(), 0o755); err != nil {
		return err
	}
	if s.ring == nil {
		return s.platform.Share([]string{s.logsDir()})
	}
	share := filepath.Join(s.logsDir(), "share")
	os.RemoveAll(share)
	if err := os.MkdirAll(share, 0o755); err != nil {
		return err
	}
	stamp := time.Now().Format("20060102-150405")
	body, _ := os.ReadFile(LastLog(s))
	main := filepath.Join(share, "peli-log-"+stamp+".txt")
	if err := os.WriteFile(main, append([]byte(header(s)+"\n"), body...), 0o644); err != nil {
		return err
	}
	paths := []string{main}
	if data, err := os.ReadFile(previousLog(s)); err == nil && len(data) > 0 {
		p := filepath.Join(share, "peli-previous-log.txt")
		if os.WriteFile(p, data, 0o644) == nil {
			paths = append(paths, p)
		}
	}
	if c := s.LastCrash(); c != nil {
		if data, err := os.ReadFile(filepath.Join(s.crashDir(), c.Name)); err == nil {
			p := filepath.Join(share, "peli-crash-"+strings.TrimSuffix(c.Name, ".txt")+".txt")
			if os.WriteFile(p, data, 0o644) == nil {
				paths = append(paths, p)
			}
		}
	}
	return s.platform.Share(paths)
}

// header is the first lines of a shared log.
func header(s *Service) string {
	var b strings.Builder
	fmt.Fprintf(&b, "Peli %s (%s/%s, %s)\n", appinfo.Version, runtime.GOOS, runtime.GOARCH, runtime.Version())
	fmt.Fprintf(&b, "Device: %s\n", s.platform.Device())
	if avail, footprint, ok := s.platform.Memory(); ok {
		fmt.Fprintf(&b, "Memory: available=%s footprint=%s\n", mib(avail), mib(footprint))
	}
	if c := s.LastCrash(); c != nil {
		fmt.Fprintf(&b, "Last crash: %s (%s)\n", c.Time.Format(time.RFC3339), c.Name)
	}
	fmt.Fprintf(&b, "Shared: %s\n", time.Now().Format(time.RFC3339))
	return b.String()
}

// ErrNotDev is DevCrash in a build without the rig.
var ErrNotDev = errors.New("diagnostics: not a dev build")

// DevCrash breaks Go on purpose, for the rig (pelidev builds only):
//   - "panic": a bare goroutine panics, which ends the app and leaves a
//     crash file;
//   - "panic-recovered": the same through safego, which logs and goes on;
//   - "memory-warning": what a memory warning from iOS does.
func (s *Service) DevCrash(kind string) error {
	if !DevBuild {
		return ErrNotDev
	}
	slog.Warn("dev crash", "kind", kind)
	switch kind {
	case "panic":
		Flush(s)
		go func() { panic("pelidev: a goroutine panicked on purpose") }()
	case "panic-recovered":
		safego.Go("pelidev", func() { panic("pelidev: a recovered panic, on purpose") })
	case "memory-warning":
		MemoryWarning(s)
	default:
		return fmt.Errorf("diagnostics: unknown crash %q", kind)
	}
	return nil
}

// webCacheTrimmer is a Platform that can drop the webview's memory cache:
// iOS (internal/iosshell). The desktop has none, and TrimWebCache does
// nothing there.
type webCacheTrimmer interface{ TrimWebCache() }

// webviewTransparer is a Platform that can make the webview see-through
// (iOS): the video plays in a UIKit view under it. Transparent from the
// start, the player no longer flips the webview's opacity mid-session.
type webviewTransparer interface{ MakeWebviewTransparent() (ok bool) }

// webviewLoader is a Platform that can load an address in the webview
// (iOS): the watchdog's recovery.
type webviewLoader interface{ LoadWebview(url string) }

// makeWebviewTransparent makes the webview see-through, once it is there.
// True when there is nothing to wait for: the webview is transparent, or
// the platform has no webview to make transparent at all.
func (s *Service) makeWebviewTransparent() bool {
	t, ok := s.platform.(webviewTransparer)
	if !ok {
		return true
	}
	return t.MakeWebviewTransparent()
}

// loadWebview loads url in the webview ("" shows the error page). It does
// nothing on a platform that cannot (the desktop, which never starts the
// watchdog either).
func (s *Service) loadWebview(url string) {
	if l, ok := s.platform.(webviewLoader); ok {
		l.LoadWebview(url)
	}
}

// TrimWebCache drops WebKit's in-memory cache, decoded images with it (#128).
// The frontend calls it on iOS when the page changes and on a memory
// warning; WebKit's content process is killed for memory before the app
// ever gets a warning.
func (s *Service) TrimWebCache() {
	if t, ok := s.platform.(webCacheTrimmer); ok {
		t.TrimWebCache()
	}
}

// DevMark logs one step of the rig's tab loop (#128, pelidev builds only):
// the frontend's note (route, time to the first card, images, DOM size,
// queries), then a memory line, and writes the log out, so a kill mid-loop
// leaves every step before it on disk.
func (s *Service) DevMark(note string) error {
	if !DevBuild {
		return ErrNotDev
	}
	slog.Info("dev loop", "note", clip(note, 2000))
	logMemory(s, "dev loop")
	Flush(s)
	return nil
}

// Terminated is iOS killing the webview's content process (a memory kill or
// a WebKit crash): it is logged, and the answer is what to load next, from
// the address the webview had. An empty url means the error page.
func Terminated(s *Service, current string, now time.Time) (Action, string) {
	action, n := s.recovery.died(now)
	route := Route(s)
	slog.Error(fmt.Sprintf("webview: content process terminated (n=%d)", n), "route", route, "action", actionName(action))
	logMemory(s, "terminated")
	Flush(s)
	if action == ErrorPage {
		return action, ""
	}
	return action, recoveryURL(current, route, action)
}

// NavigationFailed is a failed load in the webview (log only).
func NavigationFailed(kind, address, reason string) {
	slog.Warn("webview: navigation failed", "kind", kind, "url", clip(address, 300), "error", reason)
}

func actionName(a Action) string {
	switch a {
	case ReloadHome:
		return "home"
	case ErrorPage:
		return "error-page"
	}
	return "reload"
}

func clip(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "…"
}

func mib(b uint64) string { return fmt.Sprintf("%.0fMiB", float64(b)/(1<<20)) }

// nonePlatform has no native side.
type nonePlatform struct{}

func (nonePlatform) Share([]string) error           { return errors.New("diagnostics: nothing to share with") }
func (nonePlatform) Memory() (uint64, uint64, bool) { return 0, 0, false }
func (nonePlatform) Device() string                 { return runtime.GOOS }
