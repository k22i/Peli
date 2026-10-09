package main

/*
#cgo pkg-config: mpv
#include <mpv/client.h>
#include <stdlib.h>

// Small helpers so Go doesn't have to do pointer arithmetic on C arrays.
static const char **newArgv(int n) { return calloc(n + 1, sizeof(char *)); }
static void setArgv(const char **argv, int i, char *s) { argv[i] = s; }
static mpv_node *listValue(mpv_node_list *l, int i) { return &l->values[i]; }
static char *listKey(mpv_node_list *l, int i) { return l->keys[i]; }
*/
import "C"

import (
	"errors"
	"fmt"
	"sync"
	"time"
	"unsafe"
)

// mpv is a minimal binding to libmpv's client API (mpv/client.h): just what the
// spike needs, copied from spikes/libmpv-cgo. The render API (mpv/render.h)
// lives in the per-OS video_*.go files, in C, next to the GL code.
//
// Every call except waitEvent may run on any goroutine. waitEvent must only be
// called from the single event loop goroutine, and destroy must not race with
// anything, which the RWMutex enforces.
type mpv struct {
	mu     sync.RWMutex
	h      *C.mpv_handle
	closed bool
}

type mpvFormat = C.mpv_format

const (
	fmtNone   mpvFormat = C.MPV_FORMAT_NONE
	fmtString mpvFormat = C.MPV_FORMAT_STRING
	fmtFlag   mpvFormat = C.MPV_FORMAT_FLAG
	fmtInt64  mpvFormat = C.MPV_FORMAT_INT64
	fmtDouble mpvFormat = C.MPV_FORMAT_DOUBLE
	fmtNode   mpvFormat = C.MPV_FORMAT_NODE
)

// mpvEvent is a Go copy of mpv_event. libmpv owns the C event only until the
// next mpv_wait_event call, so everything is copied out immediately.
type mpvEvent struct {
	ID   int
	Name string
	At   time.Time // when mpv_wait_event returned it

	// property-change
	Prop  string
	Value any // nil when the property is unavailable (MPV_FORMAT_NONE)

	// end-file
	Reason string
	Error  string

	// log-message
	Log string
}

func mpvErr(rc C.int) error {
	if rc >= 0 {
		return nil
	}
	return errors.New(C.GoString(C.mpv_error_string(rc)))
}

func clientAPIVersion() string {
	v := uint32(C.mpv_client_api_version())
	return fmt.Sprintf("%d.%d", v>>16, v&0xffff)
}

// mpvCreate wraps mpv_create. It returns NULL (and prints "Non-C locale
// detected") when LC_NUMERIC isn't "C", which GTK's setlocale(LC_ALL, "")
// causes on any non-English desktop.
func mpvCreate() (*mpv, error) {
	h := C.mpv_create()
	if h == nil {
		return nil, errors.New("mpv_create returned NULL (LC_NUMERIC is not \"C\"?)")
	}
	return &mpv{h: h}, nil
}

func (m *mpv) use() (*C.mpv_handle, func(), error) {
	m.mu.RLock()
	if m.closed {
		m.mu.RUnlock()
		return nil, nil, errors.New("mpv destroyed")
	}
	return m.h, m.mu.RUnlock, nil
}

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
		return fmt.Errorf("set option %s=%s: %w", name, value, err)
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
		return fmt.Errorf("set option %s=%d: %w", name, value, err)
	}
	return nil
}

// handle exposes the raw mpv_handle to the per-OS render code, which creates
// the render context for it. The caller must not use it after destroy.
func (m *mpv) handle() *C.mpv_handle { return m.h }

func (m *mpv) initialize() error {
	h, done, err := m.use()
	if err != nil {
		return err
	}
	defer done()
	return mpvErr(C.mpv_initialize(h))
}

// command runs mpv_command synchronously, e.g. command("seek", "20", "absolute").
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
		return fmt.Errorf("mpv %v: %w", args, err)
	}
	return nil
}

func (m *mpv) setPropertyString(name, value string) error {
	h, done, err := m.use()
	if err != nil {
		return err
	}
	defer done()
	cn, cv := C.CString(name), C.CString(value)
	defer C.free(unsafe.Pointer(cn))
	defer C.free(unsafe.Pointer(cv))
	if err := mpvErr(C.mpv_set_property_string(h, cn, cv)); err != nil {
		return fmt.Errorf("set %s=%s: %w", name, value, err)
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
		return "", fmt.Errorf("get %s: unavailable", name)
	}
	defer C.mpv_free(unsafe.Pointer(s))
	return C.GoString(s), nil
}

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
		return nil, fmt.Errorf("get %s: %w", name, err)
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

// wakeup makes a blocked waitEvent return MPV_EVENT_NONE.
func (m *mpv) wakeup() {
	if h, done, err := m.use(); err == nil {
		C.mpv_wakeup(h)
		done()
	}
}

// waitEvent blocks (in C, on this goroutine's OS thread) until mpv has an
// event. Only the event loop goroutine may call it.
func (m *mpv) waitEvent(timeout float64) mpvEvent {
	h, done, err := m.use()
	if err != nil {
		return mpvEvent{ID: C.MPV_EVENT_SHUTDOWN, Name: "shutdown", At: time.Now()}
	}
	defer done()
	e := C.mpv_wait_event(h, C.double(timeout))
	ev := mpvEvent{ID: int(e.event_id), Name: C.GoString(C.mpv_event_name(e.event_id)), At: time.Now()}
	switch e.event_id {
	case C.MPV_EVENT_PROPERTY_CHANGE:
		p := (*C.mpv_event_property)(e.data)
		ev.Prop = C.GoString(p.name)
		ev.Value = valueToGo(p.format, p.data)
	case C.MPV_EVENT_END_FILE:
		ef := (*C.mpv_event_end_file)(e.data)
		ev.Reason = endFileReason(ef.reason)
		if ef.error < 0 {
			ev.Error = C.GoString(C.mpv_error_string(ef.error))
		}
	case C.MPV_EVENT_LOG_MESSAGE:
		lm := (*C.mpv_event_log_message)(e.data)
		ev.Log = C.GoString(lm.prefix) + ": " + C.GoString(lm.text)
	}
	return ev
}

// destroy waits for in-flight calls, then mpv_terminate_destroy. The event
// loop must have stopped calling waitEvent first.
func (m *mpv) destroy() {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.closed {
		return
	}
	m.closed = true
	C.mpv_terminate_destroy(m.h)
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

// nodeToGo converts an mpv_node tree to plain Go values (the shapes
// encoding/json and the Wails event bridge already understand).
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
		return nil
	}
	return valueToGo(n.format, u)
}
