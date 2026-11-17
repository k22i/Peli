package syncer

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"

	"github.com/k22i/Peli/internal/backend"
	"github.com/k22i/Peli/internal/safego"
)

// Connection is whether the app can reach Nuvio, for the frontend's offline
// indicator (#31). The app works the same either way: everything is read
// from the local store, and changes wait in the outbox.
type Connection string

const (
	Online Connection = "online"
	// Offline: Nuvio couldn't be reached at all (no network, DNS, a timeout).
	Offline Connection = "offline"
	// Unavailable: Nuvio answered, with server errors.
	Unavailable Connection = "unavailable"
)

// EventConnection tells the frontend the connection changed. Its data is a
// Connection.
const EventConnection = "sync:connection"

func init() {
	application.RegisterEvent[Connection](EventConnection)
}

// While offline, the monitor checks for the network coming back from
// ProbeMin, doubling up to ProbeMax.
const (
	ProbeMin = 5 * time.Second
	ProbeMax = time.Minute
)

// Monitor keeps track of whether Nuvio can be reached. It learns it from the
// pulls and pushes the app makes anyway (observe), and while offline it
// checks by itself with a request that needs no session and writes nothing
// (ping). When Nuvio can be reached again it calls reconnected, which sends
// the outbox and then pulls.
//
// It starts online, so a launch with the network up shows no indicator
// while the first pull is on its way. With only the Guest, nothing is pulled
// or pushed, so it stays online: the Guest never needs the network.
type Monitor struct {
	ping        func(context.Context) error
	reconnected func(context.Context)
	emit        func(Connection)

	probeMin, probeMax time.Duration

	mu    sync.Mutex
	ctx   context.Context // probes and reconnecting run with it
	state Connection
	wait  time.Duration
	timer *time.Timer
	// Set by Stop: no more probes.
	stopped bool
	// Reconnects still running, for Wait.
	running sync.WaitGroup
}

// NewMonitor returns a monitor that checks with ping while offline and calls
// reconnected when Nuvio is back.
func NewMonitor(ping func(context.Context) error, reconnected func(context.Context)) *Monitor {
	return &Monitor{
		ping: ping, reconnected: reconnected, emit: func(Connection) {},
		probeMin: ProbeMin, probeMax: ProbeMax, ctx: context.Background(), state: Online,
	}
}

// Start has probes and reconnecting run with ctx.
func (m *Monitor) Start(ctx context.Context) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.ctx, m.stopped = ctx, false
}

// Stop cancels the next probe.
func (m *Monitor) Stop() {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopped = true
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
}

// Connection is what the monitor last learnt.
func (m *Monitor) Connection() Connection {
	m.mu.Lock()
	defer m.mu.Unlock()
	return m.state
}

// classify is what err, the result of a request to Nuvio, says about the
// connection. ok is false if it says nothing: the request was cancelled, or
// the session had ended, which may be known without asking Nuvio.
func classify(err error) (Connection, bool) {
	switch {
	case backend.Unreachable(err):
		return Offline, true
	case backend.Unavailable(err):
		return Unavailable, true
	case err != nil && (backend.SignedOut(err) || isCancelled(err)):
		return "", false
	}
	return Online, true
}

// observe records the result of a request to Nuvio.
func (m *Monitor) observe(err error) {
	next, ok := classify(err)
	if !ok {
		return
	}
	m.mu.Lock()
	prev := m.state
	if next == prev {
		m.mu.Unlock()
		return
	}
	m.state = next
	ctx := m.ctx
	switch {
	case next == Online:
		m.wait = 0
		if m.timer != nil {
			m.timer.Stop()
			m.timer = nil
		}
	case next == Offline && !m.stopped:
		// Nuvio being down is the backend's to fix, and the pull's poll and
		// the push's backoff are kinder to it than a probe every few
		// seconds; the network coming back is worth noticing at once.
		m.wait = m.probeMin
		m.arm()
	case m.timer != nil:
		m.timer.Stop()
		m.timer = nil
	}
	m.mu.Unlock()

	m.emit(next)
	if next == Online {
		m.running.Go(func() { m.reconnected(ctx) })
	}
}

// Wait waits for a reconnect that is still running, at shutdown once its
// context is cancelled.
func (m *Monitor) Wait() { m.running.Wait() }

// arm schedules the next probe. Call with m.mu held.
func (m *Monitor) arm() {
	if m.timer != nil {
		m.timer.Stop()
	}
	m.timer = time.AfterFunc(m.wait, func() {
		defer safego.Recover("syncer: connection probe")
		m.probe()
	})
}

// probe checks the connection and, if still offline, schedules the next check
// a little later.
func (m *Monitor) probe() {
	m.mu.Lock()
	ctx := m.ctx
	m.timer = nil
	m.mu.Unlock()

	m.observe(m.ping(ctx))

	m.mu.Lock()
	defer m.mu.Unlock()
	if m.state == Offline && !m.stopped && m.timer == nil && ctx.Err() == nil {
		m.wait = min(m.wait*2, m.probeMax)
		m.arm()
	}
}

// Wake is for the app coming back after being suspended (iOS). Timers don't
// run while the process is suspended, and the monotonic clock Go's timers
// use stops while the device sleeps, so a probe armed before could wait out
// its whole interval (up to ProbeMax) again. When Nuvio wasn't reachable it
// probes now and starts the intervals over, rather than waiting for them.
// It returns at once; the answer is the usual observe.
func (m *Monitor) Wake() {
	m.mu.Lock()
	if m.state == Online || m.stopped {
		m.mu.Unlock()
		return
	}
	if m.timer != nil {
		m.timer.Stop()
		m.timer = nil
	}
	m.wait = m.probeMin
	m.mu.Unlock()
	safego.Go("syncer: connection probe", m.probe)
}

// Check asks Nuvio now, if it isn't known to be reachable, and returns the
// connection: for the frontend's "Try again" and the webview's online event.
func (m *Monitor) Check(ctx context.Context) Connection {
	if m.Connection() == Online {
		return Online
	}
	m.observe(m.ping(ctx))
	return m.Connection()
}

func isCancelled(err error) bool {
	return errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded)
}
