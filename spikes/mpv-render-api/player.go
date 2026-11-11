package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// observed lists the properties we observe, with the format libmpv should
// deliver them in. The observe id is the index + 1.
var observed = []struct {
	name   string
	format mpvFormat
}{
	{"time-pos", fmtDouble},
	{"duration", fmtDouble},
	{"pause", fmtFlag},
	{"track-list", fmtNode},
	{"paused-for-cache", fmtFlag},
	{"cache-buffering-state", fmtInt64},
	{"demuxer-cache-duration", fmtDouble},
	{"seeking", fmtFlag},
	{"eof-reached", fmtFlag},
	{"path", fmtString},
	{"video-params", fmtNode},
	{"hwdec-current", fmtString},
	{"vo-configured", fmtFlag},
	{"osd-width", fmtInt64},
	{"osd-height", fmtInt64},
	{"container-fps", fmtDouble},
}

// Events emitted to React. Every payload carries ts: the Go wall clock in
// microseconds when mpv_wait_event returned the underlying mpv event, so the
// frontend can measure delivery latency.
const (
	evTime      = "player:time"      // {pos, duration, ts}
	evTracks    = "player:tracks"    // {tracks, ts}
	evBuffering = "player:buffering" // {buffering, percent, cacheSecs, seeking, ts}
	evEnded     = "player:ended"     // {reason, error, ts}
	evState     = "player:state"     // {name, value, ts}: pause, path, hwdec, ...
)

type Info struct {
	OS               string         `json:"os"`
	Mode             string         `json:"mode"`
	Host             string         `json:"host"`
	WID              int64          `json:"wid"`
	WIDKind          string         `json:"widKind"`
	ClientAPI        string         `json:"clientApi"`
	MpvVersion       string         `json:"mpvVersion"`
	MpvConfiguration string         `json:"mpvConfiguration"`
	Locale           map[string]any `json:"locale,omitempty"`
	Embed            map[string]any `json:"embed"`
	RenderMode       int            `json:"renderMode"` // 0 = wid (no render API)
	HDR              int            `json:"hdr"`
	HTTPURL          string         `json:"httpUrl"`
	SlowURL          string         `json:"slowUrl"`
	LocalFile        string         `json:"localFile"`
	Error            string         `json:"error,omitempty"`
}

type StepResult struct {
	Step   string `json:"step"`
	OK     bool   `json:"ok"`
	Detail string `json:"detail"`
	Ms     int64  `json:"ms"`
}

type InputEvent struct {
	Kind   string `json:"kind"`
	Detail string `json:"detail"`
	Window string `json:"window"`
	At     string `json:"at"`
}

// Player is the Wails service the React overlay calls into.
type Player struct {
	mode    string
	app     *application.App
	window  *application.WebviewWindow
	overlay *application.WebviewWindow

	mpv      *mpv
	loopDone chan struct{}
	closing  bool
	server   *http.Server

	mu          sync.Mutex
	props       map[string]any
	propAt      map[string]time.Time // when each property last changed (Go side)
	endFiles    []mpvEvent
	lastRestart time.Time
	emitted     map[string]int
	info        Info
	steps       []StepResult
	inputs      []InputEvent
	goLatency   map[string][]float64 // command -> property-change, ms, measured in Go
	jsLatency   map[string][]float64 // Go emit -> React handler, ms, reported by the frontend
	jsCounts    map[string]int
	jsOffsets   []float64
	flushed     chan struct{}
	done        bool

	render      int            // render API mode (video.h), 0 for the wid modes
	procsBefore map[int]string // processes that existed before us (macOS WebKit attribution)
	extra       map[string]any // bench / resize / hdr results for the JSON
}

func newPlayer(mode string) *Player {
	return &Player{
		mode: mode, props: map[string]any{}, propAt: map[string]time.Time{}, emitted: map[string]int{},
		goLatency: map[string][]float64{}, jsLatency: map[string][]float64{}, jsCounts: map[string]int{},
		info:  Info{OS: runtime.GOOS, Mode: mode, WID: -1, ClientAPI: clientAPIVersion()},
		extra: map[string]any{}, procsBefore: procSnapshot(),
	}
}

// --- methods bound to the frontend -----------------------------------------

func (p *Player) GetInfo() Info {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.info
}

func (p *Player) GetProps() map[string]any {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make(map[string]any, len(p.props))
	for k, v := range p.props {
		out[k] = v
	}
	return out
}

// Ping returns the Go wall clock in microseconds. The frontend uses it to
// measure call round trips and the JS/Go clock offset.
func (p *Player) Ping() int64 { return time.Now().UnixMicro() }

func (p *Player) TogglePause() error { return p.cmd("cycle", "pause") }

func (p *Player) Seek(seconds float64, absolute bool) error {
	flag := "relative"
	if absolute {
		flag = "absolute"
	}
	return p.cmd("seek", fmt.Sprint(seconds), flag)
}

func (p *Player) Load(url string) error { return p.cmd("loadfile", url, "replace") }

func (p *Player) LoadLocal() error { return p.Load(p.info.LocalFile) }
func (p *Player) LoadHTTP() error  { return p.Load(p.info.HTTPURL) }
func (p *Player) LoadSlow() error  { return p.Load(p.info.SlowURL) }

// SetTrack sets aid / sid / vid; id "no" disables the track.
func (p *Player) SetTrack(kind, id string) error {
	if p.mpv == nil {
		return fmt.Errorf("mpv not running")
	}
	return p.mpv.setPropertyString(kind, id)
}

// ReportInput lets the overlay prove that pointer / keyboard input reached
// the webview rather than mpv's window.
func (p *Player) ReportInput(window, kind, detail string) {
	ev := InputEvent{Kind: kind, Detail: detail, Window: window, At: time.Now().Format("15:04:05.000")}
	p.mu.Lock()
	p.inputs = append(p.inputs, ev)
	p.mu.Unlock()
	log.Printf("[spike] input reached webview (%s): %s %s", window, kind, detail)
}

// ReportLatency receives the frontend's latency samples (ms) since its last
// report, event counts, and its current estimate of the Go-JS clock offset.
func (p *Player) ReportLatency(samples map[string][]float64, counts map[string]int, offsetMs float64, final bool) {
	p.mu.Lock()
	for k, v := range samples {
		p.jsLatency[k] = append(p.jsLatency[k], v...)
	}
	for k, v := range counts {
		p.jsCounts[k] += v
	}
	p.jsOffsets = append(p.jsOffsets, offsetMs)
	ch := p.flushed
	if final {
		p.flushed = nil
	}
	p.mu.Unlock()
	if final && ch != nil {
		close(ch)
	}
}

func (p *Player) cmd(args ...string) error {
	if p.mpv == nil {
		return fmt.Errorf("mpv not running")
	}
	return p.mpv.command(args...)
}

// --- lifecycle --------------------------------------------------------------

func mpvLogPath() string {
	if l := os.Getenv("SPIKE_MPV_LOG"); l != "" {
		return l
	}
	return filepath.Join(os.TempDir(), "peli-spike-mpv-render.log")
}

// mpvOptions are the options set before mpv_initialize, as name/value pairs.
func mpvOptions(render bool) [][2]string {
	opts := [][2]string{
		// libmpv already defaults to no config files and no terminal output.
		// With vo=libmpv, force-window would start the VO before the render
		// context exists, and mpv would fall back to a VO with its own window.
		{"idle", "yes"}, {"force-window", map[bool]string{true: "no", false: "yes"}[render]}, {"keep-open", "no"},
		// No mpv UI: React is the UI.
		{"osc", "no"}, {"osd-level", "0"},
		// Leave pointer and keyboard to the host window so input reaches the
		// webview (#2 gotcha 4: X11 needs cursor passthrough).
		{"input-default-bindings", "no"}, {"input-vo-keyboard", "no"}, {"input-cursor", "no"},
		{"input-cursor-passthrough", "yes"}, {"cursor-autohide", "no"},
		{"hwdec", "auto-safe"},
		{"background-color", "#101010"},
		{"log-file", mpvLogPath()},
	}
	// SPIKE_MPV_ARGS uses mpv's command-line spelling ("--vo=gpu-next --gpu-sw").
	for _, a := range strings.Fields(os.Getenv("SPIKE_MPV_ARGS")) {
		a = strings.TrimPrefix(a, "--")
		name, val, ok := strings.Cut(a, "=")
		if !ok {
			val = "yes"
		}
		opts = append(opts, [2]string{name, val})
	}
	return opts
}

func (p *Player) start() error {
	t0 := time.Now()
	render, err := renderMode(p.mode)
	if err != nil {
		return err
	}
	hdr, hdrOpts := hdrMode()
	p.render = render
	makeTransparent(p.window)
	if p.overlay != nil {
		makeTransparent(p.overlay)
	}
	// The native window appears asynchronously; wid=0 would mean "draw on
	// the desktop" (#2 gotcha 2), and the render hosts need the webview.
	var target nativeTarget
	for deadline := time.Now().Add(15 * time.Second); ; {
		if p.window.NativeWindow() != nil {
			if render != 0 {
				break
			}
			if target = widTarget(p); target.WID != 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("no native window handle after 15s")
		}
		time.Sleep(50 * time.Millisecond)
	}
	local := os.Getenv("SPIKE_MEDIA")
	if local == "" {
		local = "media/test.mp4"
	}
	local, _ = filepath.Abs(local)
	httpURL, slowURL, err := p.serveHTTP(local)
	if err != nil {
		return err
	}
	p.mu.Lock()
	p.info.RenderMode, p.info.HDR = render, hdr
	p.info.WID, p.info.WIDKind, p.info.Host = target.WID, target.Kind, target.Host
	if render != 0 {
		p.info.WID, p.info.WIDKind, p.info.Host = -1, "none", "render API"
	}
	p.info.LocalFile, p.info.HTTPURL, p.info.SlowURL = local, httpURL, slowURL
	p.info.Locale = fixLocale()
	p.mu.Unlock()

	tCreate := time.Now()
	m, err := mpvCreate()
	if err != nil {
		return err
	}
	opts := mpvOptions(render != 0)
	if render != 0 {
		opts = append(opts, [2]string{"vo", "libmpv"})
	}
	for _, o := range append(opts, hdrOpts...) {
		if err := m.setOptionString(o[0], o[1]); err != nil {
			log.Printf("[spike] %v", err)
		}
	}
	if render == 0 && target.WID >= 0 {
		if err := m.setOptionInt64("wid", target.WID); err != nil {
			return err
		}
	}
	if err := m.initialize(); err != nil {
		return fmt.Errorf("mpv_initialize: %w", err)
	}
	initMs := time.Since(tCreate).Milliseconds()
	p.mpv = m
	_ = m.requestLogMessages("warn")
	for i, o := range observed {
		if err := m.observe(uint64(i+1), o.name, o.format); err != nil {
			log.Printf("[spike] observe %s: %v", o.name, err)
		}
	}
	p.loopDone = make(chan struct{})
	go p.eventLoop()

	detail := fmt.Sprintf("wid=%d (%s, %s); %s", target.WID, target.Kind, target.Host, target.Note)
	if render != 0 {
		tAttach := time.Now()
		if err := attachVideo(p, m, render, hdr); err != nil {
			return err
		}
		if r := waitVideoReady(5 * time.Second); r != 1 {
			return fmt.Errorf("render context not ready (%d): %s", r, readFrameStats(false).Note)
		}
		detail = fmt.Sprintf("render mode %s (%d), hdr=%d; render context up in %dms; %v",
			p.mode, render, hdr, time.Since(tAttach).Milliseconds(), videoInfo(p)["renderer"])
	}

	ver, _ := m.getString("mpv-version")
	conf, _ := m.getString("mpv-configuration")
	p.mu.Lock()
	p.info.MpvVersion, p.info.MpvConfiguration = ver, conf
	p.mu.Unlock()
	p.record("launch", true, fmt.Sprintf("%s; libmpv client API %s; create+initialize %dms",
		detail, p.info.ClientAPI, initMs), time.Since(t0).Milliseconds())

	if p.overlay != nil {
		p.syncOverlay()
	}
	if err := p.Load(local); err != nil {
		return err
	}
	// Give the VO a beat to come up, then record how the video is hosted.
	go func() {
		time.Sleep(1500 * time.Millisecond)
		embed := inspectVideo(p, target)
		p.mu.Lock()
		p.info.Embed = embed
		info := p.info
		p.mu.Unlock()
		log.Printf("[spike] embed: %v", embed)
		p.app.Event.Emit("spike:info", info)
	}()

	if path := os.Getenv("SPIKE_SELFTEST"); path != "" {
		go p.selftest(path)
	}
	if os.Getenv("SPIKE_DEBUG_RENDERS") != "" && render != 0 {
		go func() {
			for !p.isClosing() {
				fs := readFrameStats(false)
				log.Printf("[spike] debug renders=%d frames=%d target=%dx%d time-pos=%.2f %s", fs.Renders, fs.Frames, fs.W, fs.H, p.num("time-pos"), debugCounters(p))
				time.Sleep(time.Second)
			}
		}()
	}
	return nil
}

// eventLoop is the only caller of mpv_wait_event. It turns mpv events into
// Wails events for React.
func (p *Player) eventLoop() {
	defer close(p.loopDone)
	for {
		ev := p.mpv.waitEvent(-1)
		ts := ev.At.UnixMicro()
		switch ev.Name {
		case "shutdown":
			log.Printf("[spike] mpv shutdown event")
			return
		case "none":
			if p.isClosing() {
				return
			}
		case "property-change":
			p.mu.Lock()
			p.props[ev.Prop] = ev.Value
			p.propAt[ev.Prop] = ev.At
			props := p.props
			var payload map[string]any
			name := evState
			switch ev.Prop {
			case "time-pos", "duration":
				name, payload = evTime, map[string]any{"pos": props["time-pos"], "duration": props["duration"]}
			case "track-list":
				name, payload = evTracks, map[string]any{"tracks": ev.Value}
			case "paused-for-cache", "cache-buffering-state", "demuxer-cache-duration", "seeking":
				name, payload = evBuffering, map[string]any{
					"buffering": props["paused-for-cache"] == true, "percent": props["cache-buffering-state"],
					"cacheSecs": props["demuxer-cache-duration"], "seeking": props["seeking"] == true,
				}
			default:
				payload = map[string]any{"name": ev.Prop, "value": ev.Value}
			}
			p.emitted[name]++
			p.mu.Unlock()
			payload["ts"] = ts
			p.app.Event.Emit(name, payload)
		case "end-file":
			p.mu.Lock()
			p.endFiles = append(p.endFiles, ev)
			p.emitted[evEnded]++
			p.mu.Unlock()
			p.app.Event.Emit(evEnded, map[string]any{"reason": ev.Reason, "error": ev.Error, "ts": ts})
		case "playback-restart":
			p.mu.Lock()
			p.lastRestart = ev.At
			p.mu.Unlock()
		case "log-message":
			log.Printf("[mpv] %s", strings.TrimSpace(ev.Log))
		}
	}
}

func (p *Player) isClosing() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.closing
}

// serveHTTP serves the local test file over loopback HTTP, once at full speed
// and once throttled below the file's bitrate so mpv has to buffer.
func (p *Player) serveHTTP(local string) (string, string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", "", err
	}
	kbps := atoi(os.Getenv("SPIKE_SLOW_KBPS"))
	if kbps == 0 {
		kbps = 80 // test.mp4 averages ~130 KB/s
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/media.mp4", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, local) })
	mux.HandleFunc("/slow.mp4", func(w http.ResponseWriter, r *http.Request) {
		f, err := os.Open(local)
		if err != nil {
			http.Error(w, err.Error(), 500)
			return
		}
		defer f.Close()
		st, _ := f.Stat()
		http.ServeContent(&throttled{ResponseWriter: w, bytesPerSec: kbps * 1024}, r, "slow.mp4", st.ModTime(), f)
	})
	p.server = &http.Server{Handler: mux}
	go func() { _ = p.server.Serve(ln) }()
	base := "http://" + ln.Addr().String()
	return base + "/media.mp4", base + "/slow.mp4", nil
}

type throttled struct {
	http.ResponseWriter
	bytesPerSec int
}

func (t *throttled) Write(b []byte) (int, error) {
	n := 0
	for len(b) > 0 {
		chunk := min(len(b), t.bytesPerSec/10)
		w, err := t.ResponseWriter.Write(b[:chunk])
		n += w
		if err != nil {
			return n, err
		}
		b = b[chunk:]
		time.Sleep(100 * time.Millisecond)
	}
	return n, nil
}

var _ io.Writer = (*throttled)(nil)

func (p *Player) syncOverlay() {
	if p.overlay == nil || p.window == nil {
		return
	}
	p.overlay.SetBounds(p.window.Bounds())
	attachOverlay(p.window, p.overlay)
}

func (p *Player) onResize() {
	resizeVideoHost(p)
	p.syncOverlay()
}

// shutdown stops the event loop, then destroys mpv. There is no separate
// process to orphan: if the host dies, playback dies with it.
func (p *Player) shutdown() {
	log.Printf("[spike] shutdown: destroying mpv")
	if p.mpv != nil {
		p.mu.Lock()
		p.closing = true
		p.mu.Unlock()
		p.mpv.wakeup()
		select {
		case <-p.loopDone:
		case <-time.After(2 * time.Second):
			log.Printf("[spike] event loop did not stop")
		}
		// The render context must be freed before the core is destroyed.
		if p.render != 0 {
			detachVideo()
		}
		p.mpv.destroy()
	}
	if p.server != nil {
		_ = p.server.Shutdown(context.Background())
	}
}

// --- self-test --------------------------------------------------------------

func (p *Player) record(step string, ok bool, detail string, ms int64) {
	p.mu.Lock()
	p.steps = append(p.steps, StepResult{Step: step, OK: ok, Detail: detail, Ms: ms})
	p.mu.Unlock()
	log.Printf("[spike] step %-14s ok=%v %dms %s", step, ok, ms, detail)
}

func (p *Player) prop(name string) any {
	p.mu.Lock()
	defer p.mu.Unlock()
	return p.props[name]
}

func (p *Player) num(name string) float64 {
	if f, ok := p.prop(name).(float64); ok {
		return f
	}
	return math.NaN()
}

func waitFor(timeout time.Duration, cond func() bool) (time.Duration, bool) {
	t0 := time.Now()
	for time.Since(t0) < timeout {
		if cond() {
			return time.Since(t0), true
		}
		time.Sleep(5 * time.Millisecond)
	}
	return time.Since(t0), false
}

// timedCommand runs a command and waits for cond. The latency it records
// is from just before mpv_command to the moment the event loop received the
// property-change for prop that satisfied cond, so the polling interval
// doesn't affect it.
func (p *Player) timedCommand(label, prop string, cond func() bool, args ...string) (float64, bool) {
	t0 := time.Now()
	if err := p.cmd(args...); err != nil {
		log.Printf("[spike] %s: %v", label, err)
		return 0, false
	}
	_, ok := waitFor(5*time.Second, cond)
	p.mu.Lock()
	at := p.propAt[prop]
	p.mu.Unlock()
	ms := float64(at.Sub(t0).Microseconds()) / 1000
	if ok && ms >= 0 {
		p.mu.Lock()
		p.goLatency[label] = append(p.goLatency[label], ms)
		p.mu.Unlock()
	}
	return ms, ok
}

func (p *Player) playStep(step, url string) {
	p.mu.Lock()
	delete(p.props, "time-pos")
	p.lastRestart = time.Time{}
	p.mu.Unlock()
	t0 := time.Now()
	if err := p.Load(url); err != nil {
		p.record(step, false, err.Error(), 0)
		return
	}
	// loadfile is asynchronous: wait for the new path so a time-pos from the
	// previous file can't satisfy the check.
	d, ok := waitFor(20*time.Second, func() bool { return p.prop("path") == url && p.num("time-pos") >= 1.0 })
	p.mu.Lock()
	restart := p.lastRestart
	p.mu.Unlock()
	first := int64(-1)
	if !restart.IsZero() {
		first = restart.Sub(t0).Milliseconds()
	}
	p.record(step, ok, fmt.Sprintf("%s loadfile->playback-restart=%dms time-pos=%.2f duration=%.2f hwdec=%v",
		url, first, p.num("time-pos"), p.num("duration"), p.prop("hwdec-current")), d.Milliseconds())
}

func (p *Player) selftest(out string) {
	defer p.finishSelftest()
	// The first file was loaded by start(); restart it so we can time it.
	p.playStep("play-local", p.info.LocalFile)

	tracks, _ := p.prop("track-list").([]any)
	kinds := map[string]int{}
	for _, t := range tracks {
		if m, ok := t.(map[string]any); ok {
			kinds[fmt.Sprint(m["type"])]++
		}
	}
	p.record("observe", p.num("duration") > 0 && len(tracks) > 0,
		fmt.Sprintf("duration=%.2f pause=%v tracks=%v", p.num("duration"), p.prop("pause"), kinds), 0)
	// time-pos advances even when the VO failed (#2 gotcha 1), so check video output too.
	p.record("video-out", p.prop("vo-configured") == true,
		fmt.Sprintf("vo-configured=%v video-params=%v", p.prop("vo-configured"), p.prop("video-params") != nil), 0)

	// Pause / resume a few times for a latency distribution.
	var pauseMs []float64
	ok := true
	for i := 0; i < 5; i++ {
		ms, ok1 := p.timedCommand("cmd->pause", "pause", func() bool { return p.prop("pause") == true }, "set", "pause", "yes")
		time.Sleep(150 * time.Millisecond)
		_, ok2 := p.timedCommand("cmd->pause", "pause", func() bool { return p.prop("pause") == false }, "set", "pause", "no")
		time.Sleep(150 * time.Millisecond)
		ok = ok && ok1 && ok2
		pauseMs = append(pauseMs, ms)
	}
	_ = p.cmd("set", "pause", "yes")
	waitFor(2*time.Second, func() bool { return p.prop("pause") == true })
	before := p.num("time-pos")
	time.Sleep(600 * time.Millisecond)
	after := p.num("time-pos")
	p.record("pause", ok && math.Abs(after-before) < 0.05,
		fmt.Sprintf("time-pos %.3f -> %.3f over 600ms while paused; cmd->pause event ms %v", before, after, roundAll(pauseMs)), 0)

	// Bridge cost without mpv in the way: 30 Hz synthetic events while
	// paused (decoder and VO idle), then again while playing.
	p.ticks("tick-paused", 90)

	ms, ok := p.timedCommand("cmd->seek", "time-pos",
		func() bool { t := p.num("time-pos"); return t >= 19.5 && t <= 21.5 }, "seek", "20", "absolute")
	p.record("seek", ok, fmt.Sprintf("seek 20 absolute -> time-pos=%.3f; cmd->time-pos event %.1fms", p.num("time-pos"), ms), int64(ms))

	_ = p.cmd("set", "pause", "no")
	d, ok := waitFor(3*time.Second, func() bool { return p.prop("pause") == false && p.num("time-pos") > 20.5 })
	p.record("resume", ok, fmt.Sprintf("pause=%v time-pos=%.3f", p.prop("pause"), p.num("time-pos")), d.Milliseconds())

	p.ticks("tick-playing", 90)

	_ = p.SetTrack("aid", "2")
	time.Sleep(300 * time.Millisecond)
	aid, _ := p.mpv.getString("aid")
	p.record("track-switch", aid == "2", fmt.Sprintf("set aid=2 -> aid=%v", aid), 0)
	_ = p.SetTrack("aid", "1")

	// ended: seek near the end and wait for end-file with reason eof.
	p.mu.Lock()
	nEnd := len(p.endFiles)
	p.mu.Unlock()
	_ = p.cmd("seek", fmt.Sprint(p.num("duration")-1.5), "absolute")
	d, ok = waitFor(10*time.Second, func() bool {
		p.mu.Lock()
		defer p.mu.Unlock()
		for _, e := range p.endFiles[nEnd:] {
			if e.Reason == "eof" {
				return true
			}
		}
		return false
	})
	p.record("ended", ok, fmt.Sprintf("end-file reason=eof received=%v (player:ended emitted)", ok), d.Milliseconds())

	p.playStep("play-http", p.info.HTTPURL)

	// buffering: the throttled URL delivers less than the file's bitrate, so
	// playback must stall on the cache (paused-for-cache) and then resume.
	p.mu.Lock()
	delete(p.props, "paused-for-cache")
	p.mu.Unlock()
	_ = p.Load(p.info.SlowURL)
	d1, ok1 := waitFor(30*time.Second, func() bool { return p.prop("paused-for-cache") == true })
	d2, ok2 := waitFor(30*time.Second, func() bool { return p.prop("paused-for-cache") == false })
	p.record("buffering", ok1 && ok2, fmt.Sprintf("paused-for-cache true after %dms, false again after %dms more; percent=%v",
		d1.Milliseconds(), d2.Milliseconds(), p.prop("cache-buffering-state")), d1.Milliseconds())

	if remote := os.Getenv("SPIKE_REMOTE_URL"); remote != "" {
		p.playStep("play-remote", remote)
	}
	p.resizeStep()
	p.fullscreenStep()
	p.hdrStep()
	p.hiddenStep()
	p.benchStep()

	// Leave the local file looping for screenshots and input probes.
	_ = p.mpv.setPropertyString("loop-file", "inf")
	p.playStep("play-loop", p.info.LocalFile)

	if wait := os.Getenv("SPIKE_INPUT_WAIT"); wait != "" {
		hits := injectInput(p)
		fmt.Println("SPIKE_READY_FOR_INPUT")
		if hits != nil {
			p.setExtra("inputHitTest", hits)
		}
		time.Sleep(time.Duration(atoi(wait)) * time.Second)
	}
	p.flushFrontend()
	p.mu.Lock()
	counts := map[string]int{}
	for k, v := range p.jsCounts {
		counts[k] = v
	}
	p.mu.Unlock()
	need := []string{evTime, evTracks, evBuffering, evEnded, "ended:eof"}
	var missing []string
	for _, k := range need {
		if counts[k] == 0 {
			missing = append(missing, k)
		}
	}
	p.record("react-events", len(missing) == 0, fmt.Sprintf("received by React: %v; missing %v", counts, missing), 0)

	p.writeResults(out)
	fmt.Println("SPIKE_READY_FOR_SCREENSHOT")
	if hold := os.Getenv("SPIKE_HOLD"); hold != "" {
		time.Sleep(time.Duration(atoi(hold)) * time.Second)
	}
}

// ticks emits n "spike:tick" events at 30 Hz, stamped like player events.
func (p *Player) ticks(label string, n int) {
	for i := 0; i < n; i++ {
		p.app.Event.Emit("spike:tick", map[string]any{"label": label, "ts": time.Now().UnixMicro()})
		time.Sleep(33 * time.Millisecond)
	}
}

// flushFrontend asks React for its remaining latency samples and waits for them.
func (p *Player) flushFrontend() {
	ch := make(chan struct{})
	p.mu.Lock()
	p.flushed = ch
	p.mu.Unlock()
	p.app.Event.Emit("spike:flush", nil)
	select {
	case <-ch:
	case <-time.After(5 * time.Second):
		log.Printf("[spike] frontend did not flush latency samples")
	}
}

type stats struct {
	N    int     `json:"n"`
	Mean float64 `json:"mean"`
	P50  float64 `json:"p50"`
	P95  float64 `json:"p95"`
	P99  float64 `json:"p99"`
	Max  float64 `json:"max"`
}

func summarize(xs []float64) stats {
	if len(xs) == 0 {
		return stats{}
	}
	s := append([]float64(nil), xs...)
	sort.Float64s(s)
	q := func(f float64) float64 { return round(s[min(len(s)-1, int(f*float64(len(s))))]) }
	sum := 0.0
	for _, x := range s {
		sum += x
	}
	return stats{N: len(s), Mean: round(sum / float64(len(s))), P50: q(0.5), P95: q(0.95), P99: q(0.99), Max: round(s[len(s)-1])}
}

func round(x float64) float64 { return math.Round(x*100) / 100 }

func roundAll(xs []float64) []float64 {
	out := make([]float64, len(xs))
	for i, x := range xs {
		out[i] = round(x)
	}
	return out
}

func (p *Player) writeResults(out string) {
	p.mu.Lock()
	goLat, jsLat := map[string]stats{}, map[string]stats{}
	for k, v := range p.goLatency {
		goLat[k] = summarize(v)
	}
	for k, v := range p.jsLatency {
		jsLat[k] = summarize(v)
	}
	res := map[string]any{
		"os": runtime.GOOS, "arch": runtime.GOARCH, "mode": p.mode,
		"info": p.info, "steps": p.steps, "inputs": p.inputs,
		"latencyMs": map[string]any{
			"go":            goLat,
			"react":         jsLat,
			"clockOffsetMs": roundAll(p.jsOffsets),
		},
		"video":          p.extra,
		"eventsEmitted":  p.emitted,
		"eventsReceived": p.jsCounts,
		"rssMB":          rssMB(),
		"numCPU":         runtime.NumCPU(),
		"env": map[string]string{
			"XDG_SESSION_TYPE": os.Getenv("XDG_SESSION_TYPE"),
			"GDK_BACKEND":      os.Getenv("GDK_BACKEND"),
			"DISPLAY":          os.Getenv("DISPLAY"),
			"LANG":             os.Getenv("LANG"),
			"LC_ALL":           os.Getenv("LC_ALL"),
			"WAYLAND_DISPLAY":  os.Getenv("WAYLAND_DISPLAY"),
			"GSK_RENDERER":     os.Getenv("GSK_RENDERER"),
			"SPIKE_MPV_ARGS":   os.Getenv("SPIKE_MPV_ARGS"),
		},
	}
	p.mu.Unlock()
	b, _ := json.MarshalIndent(res, "", "  ")
	if err := os.WriteFile(out, b, 0o644); err != nil {
		log.Printf("[spike] write results: %v", err)
	}
}

func (p *Player) finishSelftest() {
	path := os.Getenv("SPIKE_SELFTEST")
	if path == "" {
		return
	}
	p.mu.Lock()
	if p.done {
		p.mu.Unlock()
		return
	}
	p.done = true
	p.mu.Unlock()
	p.writeResults(path)
	if os.Getenv("SPIKE_EXIT") != "0" {
		p.app.Quit()
	}
}
