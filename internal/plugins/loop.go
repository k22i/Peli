package plugins

import (
	"context"
	"errors"
	"sync"
	"time"

	"github.com/dop251/goja"
)

// maxTimers caps the timers a plugin may have waiting at once.
const maxTimers = 10_000

// loop is a plugin's event loop. The runtime is only touched on the loop's
// goroutine: work done elsewhere (a fetch, a timer firing) posts a function
// back to it. pending counts what is still to come back, so the loop knows
// when nothing can settle the plugin's promise any more.
type loop struct {
	vm *goja.Runtime

	mu    sync.Mutex
	queue []func() error
	wake  chan struct{}

	pending int
	timers  map[int64]*timer
	next    int64
}

type timer struct {
	t        *time.Timer
	fn       goja.Callable
	args     []goja.Value
	interval time.Duration
	repeat   bool
	done     bool
}

func newLoop(vm *goja.Runtime) *loop {
	return &loop{vm: vm, wake: make(chan struct{}, 1), timers: map[int64]*timer{}}
}

// post runs f on the loop. Safe from any goroutine.
func (l *loop) post(f func() error) {
	l.mu.Lock()
	l.queue = append(l.queue, f)
	l.mu.Unlock()
	select {
	case l.wake <- struct{}{}:
	default:
	}
}

// hold notes that something will come back to the loop, and returns how it
// comes back: post its function from any goroutine, once.
func (l *loop) hold() func(func() error) {
	l.pending++
	return func(f func() error) {
		l.post(func() error {
			l.pending--
			return f()
		})
	}
}

// run takes jobs until settled says so, ctx ends or nothing is left that
// could settle it.
func (l *loop) run(ctx context.Context, settled func() bool) error {
	for {
		if settled() {
			return nil
		}
		l.mu.Lock()
		jobs := l.queue
		l.queue = nil
		l.mu.Unlock()
		if len(jobs) == 0 {
			if l.pending == 0 {
				return ErrStalled
			}
			select {
			case <-l.wake:
			case <-ctx.Done():
				return context.Cause(ctx)
			}
			continue
		}
		for _, job := range jobs {
			if err := ctx.Err(); err != nil {
				return context.Cause(ctx)
			}
			if err := job(); err != nil {
				return err
			}
			if settled() {
				return nil
			}
		}
	}
}

// fatal is err if it must stop the plugin (an interrupt: the time or
// memory limit), nil if it was only the plugin's own exception, as a
// browser reports an exception in a timer and carries on.
func fatal(err error) error {
	var exception *goja.Exception
	if err == nil || errors.As(err, &exception) {
		return nil
	}
	return err
}

// setTimer is setTimeout and setInterval.
func (l *loop) setTimer(fn goja.Callable, ms float64, args []goja.Value, repeat bool) (int64, error) {
	if len(l.timers) >= maxTimers {
		return 0, errors.New("too many timers")
	}
	delay := time.Duration(0)
	if ms > 0 && ms < float64(24*time.Hour/time.Millisecond) {
		delay = time.Duration(ms * float64(time.Millisecond))
	}
	l.next++
	id := l.next
	t := &timer{fn: fn, args: args, interval: delay, repeat: repeat}
	l.timers[id] = t
	l.pending++
	l.arm(id, t)
	return id, nil
}

func (l *loop) arm(id int64, t *timer) {
	t.t = time.AfterFunc(t.interval, func() {
		l.post(func() error {
			if t.done {
				return nil
			}
			if t.repeat {
				l.arm(id, t)
			} else {
				t.done = true
				delete(l.timers, id)
				l.pending--
			}
			_, err := t.fn(goja.Undefined(), t.args...)
			return fatal(err)
		})
	})
}

func (l *loop) clearTimer(id int64) {
	t, ok := l.timers[id]
	if !ok {
		return
	}
	t.done = true
	t.t.Stop()
	delete(l.timers, id)
	l.pending--
}

// stop stops every timer, once the call is over.
func (l *loop) stop() {
	for id := range l.timers {
		l.clearTimer(id)
	}
}
