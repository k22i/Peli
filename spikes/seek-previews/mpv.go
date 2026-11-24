package main

/*
#cgo pkg-config: mpv
#include <mpv/client.h>
#include <stdlib.h>

static const char **newArgv(int n) { return calloc(n + 1, sizeof(char *)); }
static void setArgv(const char **a, int i, const char *s) { a[i] = s; }
static mpv_node_list *nodeList(mpv_node *n) { return n->u.list; }
static mpv_byte_array *nodeBytes(mpv_node *n) { return n->u.ba; }
static mpv_node *listValue(mpv_node_list *l, int i) { return &l->values[i]; }
static char *listKey(mpv_node_list *l, int i) { return l->keys[i]; }
*/
import "C"

import (
	"errors"
	"fmt"
	"time"
	"unsafe"
)

// A minimal libmpv binding for the spike: one handle, used from one
// goroutine. internal/player's is the real one.
type mpv struct{ h *C.mpv_handle }

func newMpv(opts [][2]string) (*mpv, error) {
	h := C.mpv_create()
	if h == nil {
		return nil, errors.New("mpv_create failed")
	}
	m := &mpv{h: h}
	for _, o := range opts {
		if err := m.setOption(o[0], o[1]); err != nil {
			return nil, err
		}
	}
	if rc := C.mpv_initialize(h); rc < 0 {
		return nil, fmt.Errorf("mpv_initialize: %s", C.GoString(C.mpv_error_string(rc)))
	}
	return m, nil
}

func (m *mpv) destroy() { C.mpv_terminate_destroy(m.h) }

func (m *mpv) setOption(name, value string) error {
	cn, cv := C.CString(name), C.CString(value)
	defer C.free(unsafe.Pointer(cn))
	defer C.free(unsafe.Pointer(cv))
	if rc := C.mpv_set_option_string(m.h, cn, cv); rc < 0 {
		return fmt.Errorf("option %s: %s", name, C.GoString(C.mpv_error_string(rc)))
	}
	return nil
}

func (m *mpv) setProperty(name, value string) error {
	cn, cv := C.CString(name), C.CString(value)
	defer C.free(unsafe.Pointer(cn))
	defer C.free(unsafe.Pointer(cv))
	if rc := C.mpv_set_property_string(m.h, cn, cv); rc < 0 {
		return fmt.Errorf("set %s: %s", name, C.GoString(C.mpv_error_string(rc)))
	}
	return nil
}

func (m *mpv) getString(name string) string {
	cn := C.CString(name)
	defer C.free(unsafe.Pointer(cn))
	s := C.mpv_get_property_string(m.h, cn)
	if s == nil {
		return ""
	}
	defer C.mpv_free(unsafe.Pointer(s))
	return C.GoString(s)
}

func (m *mpv) command(args ...string) (any, error) {
	argv := C.newArgv(C.int(len(args)))
	defer C.free(unsafe.Pointer(argv))
	for i, a := range args {
		s := C.CString(a)
		defer C.free(unsafe.Pointer(s))
		C.setArgv(argv, C.int(i), s)
	}
	var res C.mpv_node
	if rc := C.mpv_command_ret(m.h, argv, &res); rc < 0 {
		return nil, fmt.Errorf("%s: %s", args[0], C.GoString(C.mpv_error_string(rc)))
	}
	defer C.mpv_free_node_contents(&res)
	return nodeToGo(&res), nil
}

func nodeToGo(n *C.mpv_node) any {
	switch n.format {
	case C.MPV_FORMAT_STRING:
		return C.GoString(*(**C.char)(unsafe.Pointer(&n.u)))
	case C.MPV_FORMAT_INT64:
		return int64(*(*C.int64_t)(unsafe.Pointer(&n.u)))
	case C.MPV_FORMAT_DOUBLE:
		return float64(*(*C.double)(unsafe.Pointer(&n.u)))
	case C.MPV_FORMAT_FLAG:
		return *(*C.int)(unsafe.Pointer(&n.u)) != 0
	case C.MPV_FORMAT_BYTE_ARRAY:
		ba := C.nodeBytes(n)
		return C.GoBytes(ba.data, C.int(ba.size))
	case C.MPV_FORMAT_NODE_MAP:
		l := C.nodeList(n)
		out := map[string]any{}
		for i := 0; i < int(l.num); i++ {
			out[C.GoString(C.listKey(l, C.int(i)))] = nodeToGo(C.listValue(l, C.int(i)))
		}
		return out
	case C.MPV_FORMAT_NODE_ARRAY:
		l := C.nodeList(n)
		out := make([]any, int(l.num))
		for i := range out {
			out[i] = nodeToGo(C.listValue(l, C.int(i)))
		}
		return out
	}
	return nil
}

// Event ids the spike waits for.
const (
	evShutdown        = C.MPV_EVENT_SHUTDOWN
	evEndFile         = C.MPV_EVENT_END_FILE
	evFileLoaded      = C.MPV_EVENT_FILE_LOADED
	evPlaybackRestart = C.MPV_EVENT_PLAYBACK_RESTART
)

// waitFor returns when event id arrives, end-file comes first, or the
// timeout passes.
func (m *mpv) waitFor(id C.mpv_event_id, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		left := time.Until(deadline)
		if left <= 0 {
			return errors.New("timeout")
		}
		ev := C.mpv_wait_event(m.h, C.double(left.Seconds()))
		switch ev.event_id {
		case id:
			return nil
		case evEndFile:
			return errors.New("end-file")
		case evShutdown:
			return errors.New("shutdown")
		}
	}
}
