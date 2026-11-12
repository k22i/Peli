//go:build !ios

package player

/*
#cgo darwin linux pkg-config: mpv
#cgo windows LDFLAGS: -lmpv
#include <mpv/client.h>
#include <stdlib.h>

// Small helpers so Go doesn't have to do pointer arithmetic on C arrays.
static const char **newArgv(int n) { return calloc(n + 1, sizeof(char *)); }
static void setArgv(const char **argv, int i, char *s) { argv[i] = s; }
static mpv_node *listValue(mpv_node_list *l, int i) { return &l->values[i]; }
static char *listKey(mpv_node_list *l, int i) { return l->keys[i]; }
static mpv_byte_array *byteArray(mpv_node *n) { return n->u.ba; }

// setStringList sets a list option or property (such as http-header-fields)
// from n strings, as an mpv_node array, so values may hold commas.
static int setStringList(mpv_handle *h, const char *name, char **values, int n) {
	mpv_node items[n > 0 ? n : 1];
	for (int i = 0; i < n; i++) {
		items[i].format = MPV_FORMAT_STRING;
		items[i].u.string = values[i];
	}
	mpv_node_list list = {.num = n, .values = items};
	mpv_node node = {.format = MPV_FORMAT_NODE_ARRAY, .u.list = &list};
	return mpv_set_property(h, name, MPV_FORMAT_NODE, &node);
}
*/
import "C"

import (
	"errors"
	"fmt"
	"sync"
	"sync/atomic"
	"unsafe"
)

// mpv is a small binding to libmpv's client API (mpv/client.h), from the M0
// spikes (docs/spikes/libmpv-cgo.md). The render API (mpv/render.h) lives in
// the per-OS host code, in C, next to the GL code.
//
// Every call except waitEvent may run on any goroutine, but never on the UI
// thread (ADR-0001). waitEvent must only be called from the session's event
// loop, and destroy must not race with anything, which the RWMutex enforces.
type mpv struct {
	mu     sync.RWMutex
	h      *C.mpv_handle
	closed bool
}

// liveHandles counts mpv handles created and not yet destroyed, so tests can
// check that sessions don't leak them.
var liveHandles atomic.Int64

type mpvFormat = C.mpv_format

const (
	fmtString mpvFormat = C.MPV_FORMAT_STRING
	fmtFlag   mpvFormat = C.MPV_FORMAT_FLAG
	fmtInt64  mpvFormat = C.MPV_FORMAT_INT64
	fmtDouble mpvFormat = C.MPV_FORMAT_DOUBLE
	fmtNode   mpvFormat = C.MPV_FORMAT_NODE
)

// Event ids the session handles.
const (
	eventNone            = C.MPV_EVENT_NONE
	eventShutdown        = C.MPV_EVENT_SHUTDOWN
	eventLogMessage      = C.MPV_EVENT_LOG_MESSAGE
	eventStartFile       = C.MPV_EVENT_START_FILE
	eventEndFile         = C.MPV_EVENT_END_FILE
	eventFileLoaded      = C.MPV_EVENT_FILE_LOADED
	eventPlaybackRestart = C.MPV_EVENT_PLAYBACK_RESTART
	eventPropertyChange  = C.MPV_EVENT_PROPERTY_CHANGE
)

// mpvEvent is a Go copy of mpv_event. libmpv owns the C event only until the
// next mpv_wait_event call, so everything is copied out at once.
type mpvEvent struct {
	ID int

	// property-change
	Prop  string
	Value any // nil when the property is unavailable (MPV_FORMAT_NONE)

	// end-file
	Reason string
	Error  int // an mpv error code, < 0

	// log-message
	Level, Prefix, Text string
}

// mpvError is an error code from libmpv.
type mpvError int

func (e mpvError) Error() string { return C.GoString(C.mpv_error_string(C.int(e))) }

func mpvErr(rc C.int) error {
	if rc >= 0 {
		return nil
	}
	return mpvError(rc)
}

// Error codes end-file reports that the session tells apart.
const (
	errLoadingFailed = mpvError(C.MPV_ERROR_LOADING_FAILED)
	errUnknownFormat = mpvError(C.MPV_ERROR_UNKNOWN_FORMAT)
	errNothingToPlay = mpvError(C.MPV_ERROR_NOTHING_TO_PLAY)
)

// errDestroyed is returned by calls made after destroy.
var errDestroyed = errors.New("player: mpv destroyed")

// mpvCreate wraps mpv_create. It returns NULL when LC_NUMERIC isn't "C",
// which GTK's setlocale(LC_ALL, "") causes on any non-English desktop; the
// Linux host resets it first.
func mpvCreate() (*mpv, error) {
	h := C.mpv_create()
	if h == nil {
		return nil, errors.New("player: mpv_create failed (LC_NUMERIC is not \"C\"?)")
	}
	liveHandles.Add(1)
	return &mpv{h: h}, nil
}

func (m *mpv) use() (*C.mpv_handle, func(), error) {
	m.mu.RLock()
	if m.closed {
		m.mu.RUnlock()
		return nil, nil, errDestroyed
	}
	return m.h, m.mu.RUnlock, nil
}

// handle exposes the raw mpv_handle to the host code, which creates the
// render context for it. The caller must not use it after destroy.
func (m *mpv) handle() *C.mpv_handle { return m.h }

func (m *mpv) setOptionString(name, value string) error {
	h, done, err := m.use()
	if err != nil {
		return err
	}
	defer done()
	cn, cv := C.CString(name), C.CString(value)
	defer C.free(unsafe.Pointer(cn))
	defer C.free(unsafe.Pointer(cv))
	if err := mpvErr(C.mpv_set_option_string(h, cn, cv)); err != nil {
		return fmt.Errorf("player: set option %s=%s: %w", name, value, err)
	}
	return nil
}

// setOptionInt64 is how "wid" is set: the native window handle as an int64.
func (m *mpv) setOptionInt64(name string, value int64) error {
	h, done, err := m.use()
	if err != nil {
		return err
	}
	defer done()
	cn := C.CString(name)
	defer C.free(unsafe.Pointer(cn))
	v := C.int64_t(value)
	if err := mpvErr(C.mpv_set_option(h, cn, C.MPV_FORMAT_INT64, unsafe.Pointer(&v))); err != nil {
		return fmt.Errorf("player: set option %s: %w", name, err)
	}
	return nil
}

func (m *mpv) initialize() error {
	h, done, err := m.use()
	if err != nil {
		return err
	}
	defer done()
	return mpvErr(C.mpv_initialize(h))
}

// command runs mpv_command synchronously, such as command("seek", "20",
// "absolute"). Errors don't repeat the arguments: a loadfile's carry a URL,
// and stream URLs carry debrid keys.
func (m *mpv) command(args ...string) error {
	h, done, err := m.use()
	if err != nil {
		return err
	}
	defer done()
	argv := C.newArgv(C.int(len(args)))
	defer C.free(unsafe.Pointer(argv))
	for i, a := range args {
		s := C.CString(a)
		defer C.free(unsafe.Pointer(s))
		C.setArgv(argv, C.int(i), s)
	}
	if err := mpvErr(C.mpv_command(h, argv)); err != nil {
		return fmt.Errorf("player: %s: %w", args[0], err)
	}
	return nil
}

// commandResult runs a command that answers, such as screenshot-raw, and
// returns its result as plain Go values.
func (m *mpv) commandResult(args ...string) (any, error) {
	h, done, err := m.use()
	if err != nil {
		return nil, err
	}
	defer done()
	argv := C.newArgv(C.int(len(args)))
	defer C.free(unsafe.Pointer(argv))
	for i, a := range args {
		s := C.CString(a)
		defer C.free(unsafe.Pointer(s))
		C.setArgv(argv, C.int(i), s)
	}
	var result C.mpv_node
	if err := mpvErr(C.mpv_command_ret(h, argv, &result)); err != nil {
		return nil, fmt.Errorf("player: %s: %w", args[0], err)
	}
	defer C.mpv_free_node_contents(&result)
	return nodeToGo(&result), nil
}

func (m *mpv) setProperty(name, value string) error {
	h, done, err := m.use()
	if err != nil {
		return err
	}
	defer done()
	cn, cv := C.CString(name), C.CString(value)
	defer C.free(unsafe.Pointer(cn))
	defer C.free(unsafe.Pointer(cv))
	if err := mpvErr(C.mpv_set_property_string(h, cn, cv)); err != nil {
		return fmt.Errorf("player: set %s: %w", name, err)
	}
	return nil
}

// setStringList sets a list property, one item per value.
func (m *mpv) setStringList(name string, values []string) error {
	h, done, err := m.use()
	if err != nil {
		return err
	}
	defer done()
	cn := C.CString(name)
	defer C.free(unsafe.Pointer(cn))
	cs := make([]*C.char, len(values)+1)
	for i, v := range values {
		cs[i] = C.CString(v)
		defer C.free(unsafe.Pointer(cs[i]))
	}
	// The C array is built on the C side from Go memory that holds only C
	// pointers, which cgo allows.
	if err := mpvErr(C.setStringList(h, cn, &cs[0], C.int(len(values)))); err != nil {
		return fmt.Errorf("player: set %s: %w", name, err)
	}
	return nil
}

func (m *mpv) getString(name string) (string, error) {
	h, done, err := m.use()
	if err != nil {
		return "", err
	}
	defer done()
	cn := C.CString(name)
	defer C.free(unsafe.Pointer(cn))
	s := C.mpv_get_property_string(h, cn)
	if s == nil {
		return "", fmt.Errorf("player: get %s: unavailable", name)
	}
	defer C.mpv_free(unsafe.Pointer(s))
	return C.GoString(s), nil
}

// getNode reads a property as plain Go values (lists, maps, strings…).
func (m *mpv) getNode(name string) (any, error) {
	h, done, err := m.use()
	if err != nil {
		return nil, err
	}
	defer done()
	cn := C.CString(name)
	defer C.free(unsafe.Pointer(cn))
	var node C.mpv_node
	if err := mpvErr(C.mpv_get_property(h, cn, C.MPV_FORMAT_NODE, unsafe.Pointer(&node))); err != nil {
		return nil, fmt.Errorf("player: get %s: %w", name, err)
	}
	defer C.mpv_free_node_contents(&node)
	return nodeToGo(&node), nil
}

func (m *mpv) observe(id uint64, name string, format mpvFormat) error {
	h, done, err := m.use()
	if err != nil {
		return err
	}
	defer done()
	cn := C.CString(name)
	defer C.free(unsafe.Pointer(cn))
	return mpvErr(C.mpv_observe_property(h, C.uint64_t(id), cn, format))
}

func (m *mpv) requestLogMessages(level string) error {
	h, done, err := m.use()
	if err != nil {
		return err
	}
	defer done()
	cl := C.CString(level)
	defer C.free(unsafe.Pointer(cl))
	return mpvErr(C.mpv_request_log_messages(h, cl))
}

// wakeup makes a blocked waitEvent return an eventNone.
func (m *mpv) wakeup() {
	if h, done, err := m.use(); err == nil {
		C.mpv_wakeup(h)
		done()
	}
}

// waitEvent blocks (in C, on this goroutine's OS thread) until mpv has an
// event, or for timeout seconds (negative: no limit). Only the event loop may
// call it.
func (m *mpv) waitEvent(timeout float64) mpvEvent {
	h, done, err := m.use()
	if err != nil {
		return mpvEvent{ID: eventShutdown}
	}
	defer done()
	e := C.mpv_wait_event(h, C.double(timeout))
	ev := mpvEvent{ID: int(e.event_id)}
	switch e.event_id {
	case C.MPV_EVENT_PROPERTY_CHANGE:
		p := (*C.mpv_event_property)(e.data)
		ev.Prop = C.GoString(p.name)
		ev.Value = valueToGo(p.format, p.data)
	case C.MPV_EVENT_END_FILE:
		ef := (*C.mpv_event_end_file)(e.data)
		ev.Reason = endFileReason(ef.reason)
		if ef.reason == C.MPV_END_FILE_REASON_ERROR {
			ev.Error = int(ef.error)
		}
	case C.MPV_EVENT_LOG_MESSAGE:
		lm := (*C.mpv_event_log_message)(e.data)
		ev.Level, ev.Prefix, ev.Text = C.GoString(lm.level), C.GoString(lm.prefix), C.GoString(lm.text)
	}
	return ev
}

// destroy waits for in-flight calls, then mpv_terminate_destroy. The event
// loop must have stopped calling waitEvent, and the host must have freed the
// render context, first.
func (m *mpv) destroy() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	m.closed = true
	C.mpv_terminate_destroy(m.h)
	liveHandles.Add(-1)
}

func endFileReason(r C.mpv_end_file_reason) string {
	switch r {
	case C.MPV_END_FILE_REASON_EOF:
		return "eof"
	case C.MPV_END_FILE_REASON_STOP:
		return "stop"
	case C.MPV_END_FILE_REASON_QUIT:
		return "quit"
	case C.MPV_END_FILE_REASON_ERROR:
		return "error"
	case C.MPV_END_FILE_REASON_REDIRECT:
		return "redirect"
	}
	return fmt.Sprintf("reason-%d", int(r))
}

func valueToGo(format C.mpv_format, data unsafe.Pointer) any {
	if data == nil {
		return nil
	}
	switch format {
	case C.MPV_FORMAT_STRING:
		return C.GoString(*(**C.char)(data))
	case C.MPV_FORMAT_FLAG:
		return *(*C.int)(data) != 0
	case C.MPV_FORMAT_INT64:
		return int64(*(*C.int64_t)(data))
	case C.MPV_FORMAT_DOUBLE:
		return float64(*(*C.double)(data))
	case C.MPV_FORMAT_NODE:
		return nodeToGo((*C.mpv_node)(data))
	}
	return nil
}

// nodeToGo converts an mpv_node tree to plain Go values.
func nodeToGo(n *C.mpv_node) any {
	u := unsafe.Pointer(&n.u)
	switch n.format {
	case C.MPV_FORMAT_NODE_ARRAY:
		l := *(**C.mpv_node_list)(u)
		out := make([]any, int(l.num))
		for i := range out {
			out[i] = nodeToGo(C.listValue(l, C.int(i)))
		}
		return out
	case C.MPV_FORMAT_NODE_MAP:
		l := *(**C.mpv_node_list)(u)
		out := make(map[string]any, int(l.num))
		for i := 0; i < int(l.num); i++ {
			out[C.GoString(C.listKey(l, C.int(i)))] = nodeToGo(C.listValue(l, C.int(i)))
		}
		return out
	case C.MPV_FORMAT_BYTE_ARRAY:
		// Only screenshot-raw sends one: a frame's pixels, copied out.
		ba := C.byteArray(n)
		return C.GoBytes(ba.data, C.int(ba.size))
	}
	return valueToGo(n.format, u)
}
