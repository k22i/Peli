package diagnostics

import (
	"log/slog"
	"runtime"
	"runtime/debug"
	"sync/atomic"
	"time"

	"github.com/k22i/Peli/internal/safego"
)

// MemoryEvery is how often a memory line is logged while the app is active.
const MemoryEvery = 30 * time.Second

var active atomic.Bool

// Breadcrumbs logs a memory line every MemoryEvery while the app is active
// (SetActive), and writes the log out each time, so a kill leaves the last
// half minute on disk. It runs until the app ends.
func Breadcrumbs(s *Service) {
	active.Store(true)
	safego.Go("memory breadcrumbs", func() {
		for range time.Tick(MemoryEvery) {
			if active.Load() {
				logMemory(s, "")
				Flush(s)
			}
		}
	})
}

// SetActive is the app coming to the front (true) or leaving it.
func SetActive(on bool) { active.Store(on) }

// MemoryWarning is UIApplicationDidReceiveMemoryWarningNotification: logged,
// Go hands back what it can, and the frontend trims its caches.
func MemoryWarning(s *Service) {
	logMemory(s, "warning")
	debug.FreeOSMemory()
	if s.emit != nil {
		s.emit(EventMemoryWarning)
	}
	Flush(s)
}

// logMemory is the `memory:` line: Go's heap, what iOS still lets the app
// have, and the footprint iOS kills by.
func logMemory(s *Service, why string) {
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	attrs := []any{"go_heap", mib(m.HeapAlloc), "go_sys", mib(m.Sys)}
	if avail, footprint, ok := s.platform.Memory(); ok {
		attrs = append(attrs, "available", mib(avail), "footprint", mib(footprint))
	}
	if why != "" {
		attrs = append(attrs, "why", why)
	}
	slog.Info("memory:", attrs...)
}
