//go:build mpv

package main

/*
#cgo linux pkg-config: mpv
#cgo darwin windows LDFLAGS: -lmpv
#include <mpv/client.h>
#include <stdlib.h>
*/
import "C"

import (
	"runtime"
	"time"
	"unsafe"
)

const mpvLinked = true

// initMPV does what the real player service would do at startup, before any
// file is loaded: create a handle, set the options #3/#4 settled on, and
// initialise it. It then parks one goroutine in mpv_wait_event, as the event
// loop would. No VO or decoder exists until a file loads.
func initMPV() map[string]any {
	info := map[string]any{"clientAPI": uint64(C.mpv_client_api_version())}
	t0 := time.Now()
	h := C.mpv_create()
	if h == nil {
		info["error"] = "mpv_create returned NULL"
		return info
	}
	vo := "libmpv" // render API on macOS and Linux (#4)
	if runtime.GOOS == "windows" {
		vo = "gpu" // wid embedding on Windows (#3)
	}
	for _, kv := range [][2]string{{"terminal", "no"}, {"idle", "yes"}, {"vo", vo}, {"hwdec", "auto-safe"}} {
		k, v := C.CString(kv[0]), C.CString(kv[1])
		C.mpv_set_option_string(h, k, v)
		C.free(unsafe.Pointer(k))
		C.free(unsafe.Pointer(v))
	}
	if rc := C.mpv_initialize(h); rc < 0 {
		info["error"] = C.GoString(C.mpv_error_string(rc))
		return info
	}
	info["initMs"] = float64(time.Since(t0).Microseconds()) / 1000
	for _, p := range []string{"mpv-version", "ffmpeg-version"} {
		cp := C.CString(p)
		if s := C.mpv_get_property_string(h, cp); s != nil {
			info[p] = C.GoString(s)
			C.mpv_free(unsafe.Pointer(s))
		}
		C.free(unsafe.Pointer(cp))
	}
	go func() {
		for {
			if ev := C.mpv_wait_event(h, -1); ev.event_id == C.MPV_EVENT_SHUTDOWN {
				return
			}
		}
	}()
	return info
}
