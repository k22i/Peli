//go:build ios

package downloads

/*
#cgo CFLAGS: -fobjc-arc
#cgo LDFLAGS: -framework UIKit -framework Foundation -framework Network
#include <stdlib.h>
#include "platform_ios.h"
*/
import "C"

import (
	"errors"
	"os"
	"path/filepath"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/k22i/Peli/internal/safego"
)

// newPlatform is the iOS side of Platform (ADR-0064 decision 5):
// beginBackgroundTask only, no background URLSession.
func newPlatform() Platform { return iosPlatform }

var iosPlatform = &iosPlatformT{events: make(chan func(), 64)}

type iosPlatformT struct {
	// net is the latest path: bit 0 online, bit 1 expensive, bit 2 known.
	net      atomic.Uint32
	netOnce  sync.Once
	netReady chan struct{}
	readyMu  sync.Once

	mu       sync.Mutex
	watchers []func(Network)

	lifeOnce   sync.Once
	background func()
	active     func()

	tasks sync.Map // id (C.ulong) → *bgTask

	// events carries lifecycle, network and early-expiry callbacks to one
	// goroutine, so they reach Go in the order they happened: background,
	// then expiring, then active.
	events    chan func()
	eventOnce sync.Once
}

const (
	netOnline    = 1
	netExpensive = 2
	netKnown     = 4
)

func (p *iosPlatformT) enqueue(fn func()) {
	p.eventOnce.Do(func() {
		safego.Go("downloads.ios.events", func() {
			for f := range p.events {
				func() {
					defer safego.Recover("downloads.ios.event")
					f()
				}()
			}
		})
	})
	select {
	case p.events <- fn:
	default:
		// A full queue means Go is badly behind; run apart rather than drop.
		safego.Go("downloads.ios.event", fn)
	}
}

// FreeSpace is the "important usage" capacity: what iOS would free for the app.
func (p *iosPlatformT) FreeSpace(dir string) (int64, error) {
	// The folder may not exist yet; ask about the nearest one that does.
	for {
		if _, err := os.Stat(dir); err == nil {
			break
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	cdir := C.CString(dir)
	defer C.free(unsafe.Pointer(cdir))
	var out C.longlong
	if C.peli_dl_free_space(cdir, &out) != 0 {
		return 0, errors.New("downloads: cannot read free space")
	}
	return int64(out), nil
}

// Prepare creates root and keeps it out of iCloud/iTunes backups (inherited by
// the files inside). Idempotent; done on every call.
func (p *iosPlatformT) Prepare(root string) error {
	if err := os.MkdirAll(root, 0o700); err != nil {
		return err
	}
	c := C.CString(root)
	defer C.free(unsafe.Pointer(c))
	if C.peli_dl_exclude_backup(c) != 0 {
		return errors.New("downloads: cannot exclude the folder from backup")
	}
	return nil
}

func (p *iosPlatformT) startMonitor() {
	p.netOnce.Do(func() {
		p.netReady = make(chan struct{})
		C.peli_dl_network_start()
	})
}

// Network starts the monitor on first use and waits briefly for its first
// reading; until there is one it reports online and not expensive.
func (p *iosPlatformT) Network() Network {
	p.startMonitor()
	if p.net.Load()&netKnown == 0 {
		select {
		case <-p.netReady:
		case <-time.After(300 * time.Millisecond):
		}
	}
	return netFromBits(p.net.Load())
}

func netFromBits(v uint32) Network {
	if v&netKnown == 0 {
		return Network{Online: true}
	}
	return Network{Online: v&netOnline != 0, Expensive: v&netExpensive != 0}
}

func (p *iosPlatformT) WatchNetwork(fn func(Network)) {
	p.mu.Lock()
	p.watchers = append(p.watchers, fn)
	p.mu.Unlock()
	p.startMonitor()
}

//export peliDownloadsNetwork
func peliDownloadsNetwork(online, expensive C.int) {
	p := iosPlatform
	var v uint32 = netKnown
	if online != 0 {
		v |= netOnline
	}
	if expensive != 0 {
		v |= netExpensive
	}
	old := p.net.Swap(v)
	if old&netKnown == 0 {
		p.readyMu.Do(func() { close(p.netReady) })
	}
	if old == v {
		return
	}
	n := netFromBits(v)
	p.mu.Lock()
	ws := append([]func(Network){}, p.watchers...)
	p.mu.Unlock()
	if len(ws) == 0 {
		return
	}
	// Never run the watchers on the monitor's dispatch queue.
	p.enqueue(func() {
		for _, w := range ws {
			w(n)
		}
	})
}

// WatchLifecycle observes UIKit's notifications (as internal/iosplayer does):
// Wails' events.IOS.* never arrive under Peli's scene delegate.
func (p *iosPlatformT) WatchLifecycle(background, active func()) {
	p.mu.Lock()
	p.background, p.active = background, active
	p.mu.Unlock()
	p.lifeOnce.Do(func() { C.peli_dl_lifecycle_observe() })
}

//export peliDownloadsLifecycle
func peliDownloadsLifecycle(kind C.int) {
	p := iosPlatform
	p.mu.Lock()
	f := p.active
	if kind == C.PELI_DL_BACKGROUND {
		f = p.background
	}
	p.mu.Unlock()
	if f != nil {
		p.enqueue(f)
	}
}

type bgTask struct {
	id       C.ulong
	expiring func()
	once     sync.Once // expiring, at most once per Background call
	endOnce  sync.Once
}

func (t *bgTask) expire() {
	t.once.Do(func() {
		if t.expiring != nil {
			t.expiring()
		}
	})
}

// Background holds a background task. expiring runs at most once, a little
// early (under 5 s left) or from the OS expiration handler; end is idempotent
// and safe from any goroutine.
func (p *iosPlatformT) Background(expiring func()) (end func()) {
	id := C.peli_dl_background_begin()
	if id == 0 {
		// iOS refused (for instance the app is already suspended).
		return func() {}
	}
	t := &bgTask{id: id, expiring: expiring}
	p.tasks.Store(id, t)
	return func() {
		t.endOnce.Do(func() {
			p.tasks.Delete(id)
			C.peli_dl_background_end(id)
		})
	}
}

//export peliDownloadsExpiring
func peliDownloadsExpiring(id C.ulong, early C.int) {
	p := iosPlatform
	v, ok := p.tasks.Load(id)
	if !ok {
		return
	}
	t := v.(*bgTask)
	if early != 0 {
		// In order with the lifecycle events, off the main thread.
		p.enqueue(t.expire)
		return
	}
	// The OS handler: the task ends right after, so Go flushes before it does.
	t.expire()
}

// ChooseFolder: iOS keeps downloads in Application Support.
func (p *iosPlatformT) ChooseFolder() (string, error) { return "", ErrUnsupported }
