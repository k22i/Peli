// Package safego runs long-lived goroutines so that a panic in one is logged
// with its stack and reported, instead of ending the app (#127). On iOS an
// unrecovered panic kills Peli with nothing but the system's crash report to
// show for it; a loop that stops is the lesser harm.
//
// Wails-bound methods don't need it: Wails 3.1.0 recovers a panic in a bound
// method itself and rejects the frontend's call (BoundMethod.Call).
package safego

import (
	"fmt"
	"log/slog"
	"runtime/debug"
	"sync"
)

// Handler hears about every recovered panic, after it is logged: the
// diagnostics service writes the log out to a file then.
type Handler func(name string, value any, stack []byte)

var (
	mu      sync.RWMutex
	handler Handler
)

// SetHandler sets what hears about recovered panics (nil for nothing).
func SetHandler(h Handler) {
	mu.Lock()
	handler = h
	mu.Unlock()
}

// Go runs fn in a new goroutine named name, recovering a panic in it.
func Go(name string, fn func()) {
	go func() {
		defer Recover(name)
		fn()
	}()
}

// Recover is Go's recovery, for a goroutine started elsewhere (an HTTP
// handler, a callback): defer it as the first thing in the function.
func Recover(name string) {
	v := recover()
	if v == nil {
		return
	}
	stack := debug.Stack()
	slog.Error("panic recovered", "goroutine", name, "panic", fmt.Sprint(v), "stack", string(stack))
	mu.RLock()
	h := handler
	mu.RUnlock()
	if h != nil {
		h(name, v, stack)
	}
}
