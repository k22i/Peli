//go:build ios

package main

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"syscall"
	"time"
)

var lastTimeEmit atomic.Int64

// throttle lets the high-rate time-pos property through at 4 Hz.
func throttle() bool {
	now := time.Now().UnixMilli()
	last := lastTimeEmit.Load()
	if now-last < 250 {
		return false
	}
	return lastTimeEmit.CompareAndSwap(last, now)
}

func cpuSeconds() float64 {
	var ru syscall.Rusage
	_ = syscall.Getrusage(syscall.RUSAGE_SELF, &ru)
	return float64(ru.Utime.Sec) + float64(ru.Utime.Usec)/1e6 + float64(ru.Stime.Sec) + float64(ru.Stime.Usec)/1e6
}

// autostart attaches mpv as soon as the webview exists and, when the test
// driver set LIBMPV_URL, plays it and walks through LIBMPV_STEPS. Controls are
// pressed through the page (ExecJS clicks the real buttons) so the path
// button → Wails binding → Go → libmpv is what gets measured.
//
//	LIBMPV_URL    what to play          LIBMPV_LABEL  result file suffix
//	LIBMPV_STEPS  wait:N, ui:<button id>, snap:<name>, seek:<seconds>
//	LIBMPV_HWDEC  mpv hwdec value (default videotoolbox; "no" for software)
func (p *Player) autostart() {
	var err error
	for i := 0; i < 20; i++ {
		time.Sleep(300 * time.Millisecond)
		if _, err = p.Attach(); err == nil {
			break
		}
	}
	if err != nil {
		log.Printf("spike: attach failed: %v", err)
		p.app.Event.Emit("spike:error", err.Error())
		return
	}
	log.Printf("spike: attached")
	url := os.Getenv("LIBMPV_URL")
	if url == "" {
		return
	}
	label := os.Getenv("LIBMPV_LABEL")
	if label == "" {
		label = "run"
	}
	home, _ := os.UserHomeDir()
	dir := filepath.Join(home, "Documents")
	_ = os.MkdirAll(dir, 0o755)
	out, _ := os.Create(filepath.Join(dir, "result-"+label+".jsonl"))
	defer out.Close()
	write := func(v map[string]any) {
		b, _ := json.Marshal(v)
		fmt.Fprintln(out, string(b))
		out.Sync()
	}

	steps := os.Getenv("LIBMPV_STEPS")
	if steps == "" {
		steps = "wait:8,snap:a,ui:seekfwd,wait:3,snap:b,ui:audio,wait:2,ui:sub,wait:2,snap:c,ui:pause,wait:1.5,snap:paused,ui:pause,wait:2,snap:d"
	}
	t0, c0 := time.Now(), cpuSeconds()
	loadErr := p.Load(url)
	write(map[string]any{"step": "load", "err": fmt.Sprint(loadErr)})
	for _, s := range strings.Split(steps, ",") {
		kind, arg, _ := strings.Cut(s, ":")
		switch kind {
		case "wait":
			f, _ := strconv.ParseFloat(arg, 64)
			time.Sleep(time.Duration(f * float64(time.Second)))
		case "ui":
			p.win.ExecJS(fmt.Sprintf("document.getElementById(%q).click()", arg))
			time.Sleep(400 * time.Millisecond)
		case "seek":
			f, _ := strconv.ParseFloat(arg, 64)
			_ = p.SeekTo(f)
		case "snap":
			now, cn := time.Now(), cpuSeconds()
			var snap map[string]any
			_ = json.Unmarshal([]byte(p.Snapshot()), &snap)
			snap["step"] = "snap:" + arg
			snap["cpuPercentSinceStart"] = (cn - c0) / now.Sub(t0).Seconds() * 100
			snap["tracks"] = json.RawMessage(orNull(p.getProp("track-list")))
			write(snap)
			_ = os.WriteFile(filepath.Join(dir, "marker-"+label+"-"+arg), nil, 0o644)
			time.Sleep(1500 * time.Millisecond) // the driver takes its screenshot now
		}
	}
	write(map[string]any{"step": "done", "logs": p.Logs()})
	_ = os.WriteFile(filepath.Join(dir, "marker-"+label+"-done"), nil, 0o644)
}

func orNull(s string) string {
	if s == "" {
		return "null"
	}
	return s
}
