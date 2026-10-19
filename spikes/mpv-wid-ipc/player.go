package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"math"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// observed lists the properties the overlay renders and the self-test checks.
var observed = []string{"time-pos", "duration", "pause", "track-list", "eof-reached", "path", "video-params", "hwdec-current", "vo-configured"}

type PropChange struct {
	Name string `json:"name"`
	Data any    `json:"data"`
}

type CoreEvent struct {
	Event  string `json:"event"`
	Reason string `json:"reason,omitempty"`
	Error  string `json:"error,omitempty"`
}

// Info is what the overlay shows in its diagnostics panel.
type Info struct {
	OS         string         `json:"os"`
	Mode       string         `json:"mode"`
	WID        int64          `json:"wid"`
	WIDKind    string         `json:"widKind"`
	MpvBin     string         `json:"mpvBin"`
	MpvVersion string         `json:"mpvVersion"`
	Endpoint   string         `json:"endpoint"`
	Embed      map[string]any `json:"embed"`
	HTTPURL    string         `json:"httpUrl"`
	LocalFile  string         `json:"localFile"`
	Error      string         `json:"error,omitempty"`
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

	cmd    *exec.Cmd
	ipc    *ipcClient
	server *http.Server

	mu     sync.Mutex
	props  map[string]any
	info   Info
	steps  []StepResult
	inputs []InputEvent
	done   bool
}

func newPlayer(mode string) *Player {
	return &Player{mode: mode, props: map[string]any{}, info: Info{OS: runtime.GOOS, Mode: mode, WID: -1}}
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

func (p *Player) TogglePause() error { return p.cmdErr("cycle", "pause") }

func (p *Player) Seek(seconds float64, absolute bool) error {
	flag := "relative"
	if absolute {
		flag = "absolute"
	}
	return p.cmdErr("seek", seconds, flag)
}

func (p *Player) Load(url string) error { return p.cmdErr("loadfile", url, "replace") }

func (p *Player) LoadLocal() error { return p.Load(p.info.LocalFile) }
func (p *Player) LoadHTTP() error  { return p.Load(p.info.HTTPURL) }

// SetTrack sets aid / sid / vid; id "no" disables the track.
func (p *Player) SetTrack(kind string, id string) error {
	var v any = id
	if n, err := strconv.Atoi(id); err == nil {
		v = n
	}
	return p.cmdErr("set_property", kind, v)
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

func (p *Player) cmdErr(args ...any) error {
	if p.ipc == nil {
		return fmt.Errorf("mpv not running")
	}
	_, err := p.ipc.command(args...)
	return err
}

// --- lifecycle --------------------------------------------------------------

func mpvBinary() string {
	if b := os.Getenv("MPV_BIN"); b != "" {
		return b
	}
	if b, err := exec.LookPath("mpv"); err == nil {
		return b
	}
	return "mpv"
}

func mpvLogPath() string {
	if l := os.Getenv("SPIKE_MPV_LOG"); l != "" {
		return l
	}
	return filepath.Join(os.TempDir(), "cove-spike-mpv.log")
}

func (p *Player) start() error {
	t0 := time.Now()
	makeTransparent(p.window)
	if p.overlay != nil {
		makeTransparent(p.overlay)
	}
	// Window creation is asynchronous (on Windows with two windows it took
	// >5s on a CI runner), and --wid=0 means "draw on the desktop / root
	// window", so wait for a real handle instead of a fixed delay.
	var target nativeTarget
	for deadline := time.Now().Add(15 * time.Second); ; {
		if p.window.NativeWindow() != nil {
			if target = windowTarget(p.window); target.WID != 0 {
				break
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("no native window handle after 15s")
		}
		time.Sleep(50 * time.Millisecond)
	}
	endpoint := ipcEndpoint()
	local := os.Getenv("SPIKE_MEDIA")
	if local == "" {
		local = "media/test.mp4"
	}
	local, _ = filepath.Abs(local)
	httpURL, err := p.serveHTTP(local)
	if err != nil {
		return err
	}

	p.mu.Lock()
	p.info.WID, p.info.WIDKind = target.WID, target.Kind
	p.info.MpvBin, p.info.Endpoint = mpvBinary(), endpoint
	p.info.LocalFile, p.info.HTTPURL = local, httpURL
	p.mu.Unlock()

	args := []string{
		"--no-config",
		"--input-ipc-server=" + endpoint,
		"--idle=yes", "--force-window=yes", "--keep-open=yes",
		// No mpv UI: the React overlay is the UI.
		"--osc=no", "--osd-level=0", "--no-osd-bar",
		// Leave pointer and keyboard to the host window so they can reach
		// the webview (on X11 this stops mpv selecting input events).
		"--input-default-bindings=no", "--input-vo-keyboard=no", "--input-cursor=no",
		// X11: empty input shape on mpv's window so clicks fall through to
		// the parent even when a WM's passive button grab is replayed
		// (without it, clicks were lost under openbox). No-op for win32 --wid.
		"--input-cursor-passthrough=yes",
		"--cursor-autohide=no",
		"--hwdec=auto-safe",
		"--background-color=#101010",
		"--terminal=no",
		"--log-file=" + mpvLogPath(),
	}
	if target.WID >= 0 {
		args = append(args, "--wid="+strconv.FormatInt(target.WID, 10))
	}
	args = append(args, extraMpvArgs()...)
	log.Printf("[spike] launching %s %v", p.info.MpvBin, args)
	p.cmd = exec.Command(p.info.MpvBin, args...)
	p.cmd.Stdout, p.cmd.Stderr = os.Stdout, os.Stderr
	if err := p.cmd.Start(); err != nil {
		return fmt.Errorf("start mpv: %w", err)
	}
	go func() {
		err := p.cmd.Wait()
		log.Printf("[spike] mpv exited: %v", err)
	}()

	p.ipc, err = dialIPC(endpoint, 10*time.Second)
	if err != nil {
		return err
	}
	p.record("launch", true, fmt.Sprintf("--wid=%d (%s); %s; ipc %s", target.WID, target.Kind, target.Note, endpoint), time.Since(t0).Milliseconds())

	go p.pumpEvents()
	for i, name := range observed {
		if _, err := p.ipc.command("observe_property", i+1, name); err != nil {
			log.Printf("[spike] observe %s: %v", name, err)
		}
	}
	var ver string
	_ = p.ipc.getProperty("mpv-version", &ver)
	p.mu.Lock()
	p.info.MpvVersion = ver
	p.mu.Unlock()

	if p.overlay != nil {
		p.syncOverlay()
	}
	if err := p.Load(local); err != nil {
		return err
	}
	// mpv only creates its window once a file is loaded (or force-window
	// kicks in); give it a beat, then inspect where it landed.
	go func() {
		time.Sleep(1500 * time.Millisecond)
		embed := inspectEmbed(p, target)
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
	return nil
}

func (p *Player) pumpEvents() {
	for ev := range p.ipc.events {
		switch ev.Event {
		case "property-change":
			var v any
			_ = json.Unmarshal(ev.Data, &v)
			p.mu.Lock()
			p.props[ev.Name] = v
			p.mu.Unlock()
			p.app.Event.Emit("mpv:prop", PropChange{Name: ev.Name, Data: v})
		default:
			p.app.Event.Emit("mpv:event", CoreEvent{Event: ev.Event, Reason: ev.Reason, Error: ev.FileError})
		}
	}
}

// serveHTTP serves the local test file over loopback HTTP so we exercise
// mpv's network demuxer path deterministically (a public URL can be added via
// SPIKE_REMOTE_URL).
func (p *Player) serveHTTP(local string) (string, error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	mux := http.NewServeMux()
	mux.HandleFunc("/media.mp4", func(w http.ResponseWriter, r *http.Request) { http.ServeFile(w, r, local) })
	p.server = &http.Server{Handler: mux}
	go func() { _ = p.server.Serve(ln) }()
	return "http://" + ln.Addr().String() + "/media.mp4", nil
}

func (p *Player) syncOverlay() {
	if p.overlay == nil || p.window == nil {
		return
	}
	b := p.window.Bounds()
	p.overlay.SetBounds(b)
	attachOverlay(p.window, p.overlay)
}

func (p *Player) shutdown() {
	log.Printf("[spike] shutdown: stopping mpv")
	if p.ipc != nil {
		_, _ = p.ipc.command("quit")
		_ = p.ipc.close()
	}
	if p.cmd != nil && p.cmd.Process != nil {
		done := make(chan struct{})
		go func() { _ = p.cmd.Wait(); close(done) }()
		select {
		case <-done:
		case <-time.After(2 * time.Second):
			_ = p.cmd.Process.Kill()
		}
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
	log.Printf("[spike] step %-12s ok=%v %dms %s", step, ok, ms, detail)
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
		time.Sleep(25 * time.Millisecond)
	}
	return time.Since(t0), false
}

func (p *Player) playStep(step, url string, load bool) {
	if load {
		if err := p.Load(url); err != nil {
			p.record(step, false, err.Error(), 0)
			return
		}
		// Clear the stale value from the previous file before waiting.
		p.mu.Lock()
		delete(p.props, "time-pos")
		p.mu.Unlock()
	}
	d, ok := waitFor(15*time.Second, func() bool { return p.num("time-pos") >= 1.0 })
	p.record(step, ok, fmt.Sprintf("%s time-pos=%.2f duration=%.2f hwdec=%v", url, p.num("time-pos"), p.num("duration"), p.prop("hwdec-current")), d.Milliseconds())
}

func (p *Player) selftest(out string) {
	defer p.finishSelftest()
	p.playStep("play-local", p.info.LocalFile, false)

	tracks, _ := p.prop("track-list").([]any)
	kinds := map[string]int{}
	for _, t := range tracks {
		if m, ok := t.(map[string]any); ok {
			kinds[fmt.Sprint(m["type"])]++
		}
	}
	p.record("observe", p.num("duration") > 0 && len(tracks) > 0,
		fmt.Sprintf("duration=%.2f pause=%v tracks=%v", p.num("duration"), p.prop("pause"), kinds), 0)
	// time-pos advances even when the VO failed, so check video output too.
	p.record("video-out", p.prop("vo-configured") == true, fmt.Sprintf("vo-configured=%v video-params=%v", p.prop("vo-configured"), p.prop("video-params") != nil), 0)

	t0 := time.Now()
	_ = p.cmdErr("set_property", "pause", true)
	d, ok := waitFor(3*time.Second, func() bool { return p.prop("pause") == true })
	before := p.num("time-pos")
	time.Sleep(600 * time.Millisecond)
	after := p.num("time-pos")
	p.record("pause", ok && math.Abs(after-before) < 0.05, fmt.Sprintf("pause=%v time-pos %.3f -> %.3f over 600ms", p.prop("pause"), before, after), d.Milliseconds())

	t0 = time.Now()
	_ = p.Seek(20, true)
	d, ok = waitFor(5*time.Second, func() bool { t := p.num("time-pos"); return t >= 19.5 && t <= 21.5 })
	p.record("seek", ok, fmt.Sprintf("seek 20 absolute -> time-pos=%.3f", p.num("time-pos")), d.Milliseconds())
	_ = t0

	_ = p.cmdErr("set_property", "pause", false)
	d, ok = waitFor(3*time.Second, func() bool { return p.prop("pause") == false && p.num("time-pos") > 20.5 })
	p.record("resume", ok, fmt.Sprintf("pause=%v time-pos=%.3f", p.prop("pause"), p.num("time-pos")), d.Milliseconds())

	_ = p.SetTrack("aid", "2")
	time.Sleep(300 * time.Millisecond)
	var aid any
	_ = p.ipc.getProperty("aid", &aid)
	p.record("track-switch", fmt.Sprint(aid) == "2", fmt.Sprintf("set aid=2 -> aid=%v", aid), 0)
	_ = p.SetTrack("aid", "1")

	p.playStep("play-http", p.info.HTTPURL, true)
	if remote := os.Getenv("SPIKE_REMOTE_URL"); remote != "" {
		p.playStep("play-remote", remote, true)
	}
	// Leave the local HTTP stream playing for screenshots / input probes.

	if wait := os.Getenv("SPIKE_INPUT_WAIT"); wait != "" {
		secs, _ := strconv.Atoi(wait)
		fmt.Println("SPIKE_READY_FOR_INPUT")
		time.Sleep(time.Duration(secs) * time.Second)
	}
	p.writeResults(out)
	fmt.Println("SPIKE_READY_FOR_SCREENSHOT")
	if hold := os.Getenv("SPIKE_HOLD"); hold != "" {
		secs, _ := strconv.Atoi(hold)
		time.Sleep(time.Duration(secs) * time.Second)
	}
}

func (p *Player) writeResults(out string) {
	p.mu.Lock()
	res := map[string]any{
		"os": runtime.GOOS, "arch": runtime.GOARCH, "mode": p.mode,
		"info": p.info, "steps": p.steps, "inputs": p.inputs,
		"env": map[string]string{
			"XDG_SESSION_TYPE": os.Getenv("XDG_SESSION_TYPE"),
			"GDK_BACKEND":      os.Getenv("GDK_BACKEND"),
			"WAYLAND_DISPLAY":  os.Getenv("WAYLAND_DISPLAY"),
			"DISPLAY":          os.Getenv("DISPLAY"),
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

// splitArgs splits SPIKE_MPV_ARGS on spaces (no quoting; spike only).
func splitArgs(s string) []string { return strings.Fields(s) }
