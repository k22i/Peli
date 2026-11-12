//go:build ios

package main

/*
#cgo CFLAGS: -fobjc-arc -I${SRCDIR}/.fw/libmpv.framework/Headers
#cgo LDFLAGS: -F${SRCDIR}/.fw -framework libmpv -framework OpenGLES -framework UIKit -framework QuartzCore -framework Foundation
#include <stdlib.h>
#include "mpvview.h"
*/
import "C"

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"sync"
	"unsafe"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Player is the Wails service: the page calls these, and mpv's property
// changes come back as "mpv:<property>" events.
type Player struct {
	app *application.App
	win *application.WebviewWindow

	mu       sync.Mutex
	attached bool
	logs     []string
	state    map[string]string // last JSON value per property
}

var current *Player

//export goMpvEvent
func goMpvEvent(name, js *C.char) {
	p := current
	if p == nil {
		return
	}
	n, v := C.GoString(name), C.GoString(js)
	p.mu.Lock()
	if p.state == nil {
		p.state = map[string]string{}
	}
	if n == "log" {
		p.logs = append(p.logs, v)
		if len(p.logs) > 400 {
			p.logs = p.logs[len(p.logs)-400:]
		}
	} else {
		p.state[n] = v
	}
	p.mu.Unlock()
	if n == "time-pos" && !throttle() {
		return
	}
	var x any
	if json.Unmarshal([]byte(v), &x) == nil {
		p.app.Event.Emit("mpv:"+n, x)
	}
}

// Attach creates mpv and puts the video view behind the webview. Idempotent.
func (p *Player) Attach() (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.attached {
		return "attached", nil
	}
	current = p
	h := p.win.NativeWindow()
	if h == nil {
		return "", fmt.Errorf("the window has no native handle yet")
	}
	hw := C.CString(os.Getenv("LIBMPV_HWDEC"))
	defer C.free(unsafe.Pointer(hw))
	if rc := C.peli_attach(h, hw); rc != 0 {
		return "", fmt.Errorf("peli_attach failed at step %d", int(rc))
	}
	p.attached = true
	return "attached", nil
}

func (p *Player) command(args ...string) error {
	c := make([]*C.char, len(args)+1)
	for i, a := range args {
		c[i] = C.CString(a)
	}
	defer func() {
		for _, s := range c[:len(args)] {
			C.free(unsafe.Pointer(s))
		}
	}()
	if rc := C.peli_command((**C.char)(unsafe.Pointer(&c[0]))); rc < 0 {
		return fmt.Errorf("mpv %s: error %d", args[0], int(rc))
	}
	return nil
}

func (p *Player) setProp(name, value string) error {
	n, v := C.CString(name), C.CString(value)
	defer C.free(unsafe.Pointer(n))
	defer C.free(unsafe.Pointer(v))
	if rc := C.peli_set_property(n, v); rc < 0 {
		return fmt.Errorf("mpv set %s=%s: error %d", name, value, int(rc))
	}
	return nil
}

func (p *Player) getProp(name string) string {
	n := C.CString(name)
	defer C.free(unsafe.Pointer(n))
	s := C.peli_get_property(n)
	if s == nil {
		return ""
	}
	defer C.peli_free(s)
	return C.GoString(s)
}

func (p *Player) renderStats() string {
	s := C.peli_stats()
	defer C.peli_free(s)
	return C.GoString(s)
}

// Load starts a URL.
func (p *Player) Load(url string) error {
	if _, err := p.Attach(); err != nil {
		return err
	}
	return p.command("loadfile", url)
}

func (p *Player) TogglePause() error { return p.command("cycle", "pause") }

// Seek moves by delta seconds (relative, exact: the fast seek would land on keyframes).
func (p *Player) Seek(delta float64) error {
	return p.command("seek", fmt.Sprintf("%g", delta), "relative+exact")
}

func (p *Player) SeekTo(t float64) error {
	return p.command("seek", fmt.Sprintf("%g", t), "absolute+exact")
}

func (p *Player) CycleAudio() error { return p.command("cycle", "audio") }
func (p *Player) CycleSub() error   { return p.command("cycle", "sub") }
func (p *Player) Stop() error       { return p.command("stop") }

// Snapshot is everything the coverage table needs, as JSON.
func (p *Player) Snapshot() string {
	m := map[string]any{}
	for _, k := range []string{"time-pos", "duration", "pause", "aid", "sid", "hwdec-current", "video-format",
		"audio-codec-name", "core-idle", "paused-for-cache", "estimated-vf-fps", "frame-drop-count",
		"decoder-frame-drop-count", "video-codec", "audio-codec", "current-vo", "current-ao", "width", "height"} {
		m[k] = p.getProp(k)
	}
	m["render"] = json.RawMessage(p.renderStats())
	b, _ := json.Marshal(m)
	return string(b)
}

// Logs returns the last mpv log lines.
func (p *Player) Logs() string {
	p.mu.Lock()
	defer p.mu.Unlock()
	var sb strings.Builder
	for _, l := range p.logs {
		var s string
		_ = json.Unmarshal([]byte(l), &s)
		sb.WriteString(s)
	}
	return sb.String()
}
