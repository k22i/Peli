package main

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Self-test steps added for #4, on top of #3's: the video must follow the
// window through a resize and fullscreen, HDR must reach the layer as EDR
// (macOS), and the bench measures CPU/GPU cost and frame pacing.

func (p *Player) osdSize() (int64, int64) {
	w, _ := p.prop("osd-width").(int64)
	h, _ := p.prop("osd-height").(int64)
	return w, h
}

func (p *Player) setExtra(k string, v any) {
	p.mu.Lock()
	p.extra[k] = v
	p.mu.Unlock()
}

// sizeCheck describes the video size after a window change and whether the
// render target followed it (mpv's osd size is the VO's target size).
func (p *Player) sizeCheck() (string, bool) {
	w, h := p.osdSize()
	if p.render == 0 {
		return fmt.Sprintf("osd %dx%d", w, h), w > 0
	}
	fs := readFrameStats(false)
	return fmt.Sprintf("osd %dx%d, last render target %dx%d", w, h, fs.W, fs.H), int64(fs.W) == w && int64(fs.H) == h
}

func (p *Player) resizeStep() {
	w0, h0 := p.osdSize()
	p.window.SetSize(960, 540)
	d, ok := waitFor(4*time.Second, func() bool { w, _ := p.osdSize(); return w > 0 && w != w0 })
	time.Sleep(400 * time.Millisecond)
	desc, match := p.sizeCheck()
	p.record("resize", ok && match, fmt.Sprintf("window 1280x720 -> 960x540: osd %dx%d -> %s after %dms", w0, h0, desc, d.Milliseconds()), d.Milliseconds())
	p.setExtra("resize", map[string]any{"after": desc, "ms": d.Milliseconds(), "match": match})
	p.window.SetSize(1280, 720)
	waitFor(4*time.Second, func() bool { w, _ := p.osdSize(); return w == w0 })
	time.Sleep(400 * time.Millisecond)
}

func (p *Player) fullscreenStep() {
	if os.Getenv("SPIKE_SKIP_FULLSCREEN") != "" {
		return
	}
	w0, h0 := p.osdSize()
	p.window.Fullscreen()
	d, ok := waitFor(8*time.Second, func() bool { w, _ := p.osdSize(); return w > w0+50 })
	time.Sleep(1200 * time.Millisecond) // let the macOS animation finish
	desc, match := p.sizeCheck()
	fmt.Println("SPIKE_FULLSCREEN")
	time.Sleep(time.Duration(atoi(os.Getenv("SPIKE_FULLSCREEN_HOLD"))) * time.Second)
	p.record("fullscreen", ok && match, fmt.Sprintf("osd %dx%d -> %s after %dms", w0, h0, desc, d.Milliseconds()), d.Milliseconds())
	p.setExtra("fullscreen", map[string]any{"after": desc, "ms": d.Milliseconds(), "match": match})
	p.window.UnFullscreen()
	_, back := waitFor(8*time.Second, func() bool { w, _ := p.osdSize(); return w == w0 })
	time.Sleep(1200 * time.Millisecond)
	if !back {
		w, h := p.osdSize()
		p.record("unfullscreen", false, fmt.Sprintf("osd still %dx%d", w, h), 0)
	}
}

// hdrStep plays SPIKE_HDR_MEDIA, reads one rendered frame back from the GL
// back buffer and records the screen's EDR headroom before and during it.
func (p *Player) hdrStep() {
	media := os.Getenv("SPIKE_HDR_MEDIA")
	if media == "" || p.render == 0 {
		return
	}
	media, _ = filepath.Abs(media)
	before := screenEDR(p)
	p.playStep("hdr-play", media)
	time.Sleep(1500 * time.Millisecond)
	requestReadback()
	waitFor(3*time.Second, func() bool { return readFrameStats(false).Readback != nil })
	fs := readFrameStats(false)
	during := screenEDR(p)
	vp, _ := p.mpv.getNode("video-params")
	tp, _ := p.mpv.getNode("video-target-params")
	p.setExtra("hdr", map[string]any{
		"media": filepath.Base(media), "mode": p.info.HDR, "edrBefore": before, "edrDuring": during,
		"readback": fs.Readback, "videoParams": vp, "targetParams": tp,
	})
	p.record("hdr", fs.Readback != nil, fmt.Sprintf("hdr=%d readback %v; EDR before %v, during %v",
		p.info.HDR, fs.Readback, before, during), 0)
	if hold := atoi(os.Getenv("SPIKE_HDR_HOLD")); hold > 0 {
		fmt.Println("SPIKE_HDR_READY")
		time.Sleep(time.Duration(hold) * time.Second)
	}
}

var benchCounters = []string{"frame-drop-count", "decoder-frame-drop-count", "vo-delayed-frame-count", "mistimed-frame-count"}

func (p *Player) readCounters() map[string]int64 {
	out := map[string]int64{}
	for _, k := range benchCounters {
		s, _ := p.mpv.getString(k)
		out[k], _ = strconv.ParseInt(s, 10, 64)
	}
	return out
}

// window is one measurement window of the bench.
type window struct {
	secs   float64
	cpu    map[string]any // % of one core per process group
	gpu    []float64      // GPU "Device Utilization %" samples (macOS)
	mainMs []float64      // UI-thread dispatch latency samples
}

// measure samples for d: CPU of us and the processes that composite for us,
// GPU utilisation every 500ms, and every 50ms how long a no-op takes to run
// on the UI thread (InvokeSync), which shows when rendering on that thread
// starves the rest of the app.
func (p *Player) measure(d time.Duration) window {
	groups := systemProcs(p.procsBefore)
	var pids []int
	for _, g := range groups {
		pids = append(pids, g...)
	}
	self0, cpu0 := selfCPU(), procCPU(pids)
	var w window
	start := time.Now()
	for i := 0; time.Since(start) < d; i++ {
		if i%10 == 0 {
			if v, ok := gpuUtil(); ok {
				w.gpu = append(w.gpu, v)
			}
		}
		t := time.Now()
		application.InvokeSync(func() {})
		w.mainMs = append(w.mainMs, float64(time.Since(t).Microseconds())/1000)
		time.Sleep(50 * time.Millisecond)
	}
	w.secs = time.Since(start).Seconds()
	self1, cpu1 := selfCPU(), procCPU(pids)
	pct := func(sec float64) float64 { return round(sec / w.secs * 100) }
	w.cpu = map[string]any{"self": pct(self1 - self0)}
	total := self1 - self0
	for name, g := range groups {
		sum := 0.0
		for _, pid := range g {
			sum += cpu1[pid] - cpu0[pid]
		}
		w.cpu[name] = pct(sum)
		total += sum
	}
	w.cpu["total"] = pct(total)
	return w
}

// benchStep plays SPIKE_BENCH_MEDIA (looping) for SPIKE_BENCH_SECS and
// records CPU, GPU utilisation and UI-thread latency (also while paused, as
// a baseline), mpv's drop counters, and our frame pacing and render cost.
func (p *Player) benchStep() {
	media := os.Getenv("SPIKE_BENCH_MEDIA")
	if media == "" {
		media = p.info.LocalFile
	}
	media, _ = filepath.Abs(media)
	secs := atoi(os.Getenv("SPIKE_BENCH_SECS"))
	if secs == 0 {
		secs = 10
	}
	_ = p.mpv.setPropertyString("loop-file", "inf")
	p.playStep("bench-play", media)
	time.Sleep(2 * time.Second) // warm-up
	_ = p.cmd("set", "pause", "yes")
	time.Sleep(500 * time.Millisecond)
	idle := p.measure(4 * time.Second)
	_ = p.cmd("set", "pause", "no")
	time.Sleep(1 * time.Second)

	c0 := p.readCounters()
	readFrameStats(true)
	state0 := windowState(p)
	play := p.measure(time.Duration(secs) * time.Second)
	state1 := windowState(p)
	fs := readFrameStats(false)
	c1 := p.readCounters()

	mpvStats := map[string]any{}
	for _, k := range benchCounters {
		mpvStats[k] = c1[k] - c0[k]
	}
	for _, k := range []string{"estimated-vf-fps", "display-fps", "hwdec-current", "video-sync", "current-vo"} {
		v, _ := p.mpv.getString(k)
		mpvStats[k] = v
	}
	fps := p.num("container-fps")
	res := map[string]any{
		"media": filepath.Base(media), "secs": round(play.secs), "videoFps": fps, "mpv": mpvStats,
		"cpuPct": play.cpu, "cpuPausedPct": idle.cpu,
		"gpuUtilPct": summarize(play.gpu), "gpuUtilPausedPct": summarize(idle.gpu),
		"uiThreadMs": summarize(play.mainMs), "uiThreadPausedMs": summarize(idle.mainMs),
		"windowState": map[string]any{"start": state0, "end": state1},
	}
	detail := fmt.Sprintf("%s for %.1fs: cpu%% %v (paused %v); ui thread ms %v; mpv %v",
		filepath.Base(media), play.secs, play.cpu, idle.cpu, summarize(play.mainMs), mpvStats)
	if p.render != 0 {
		r := map[string]any{
			"renders": fs.Renders, "frames": fs.Frames, "framesPerSec": round(float64(fs.Frames) / play.secs),
			"pacing": pacing(fs.Intervals, fps), "renderCallMs": summarize(fs.CPU), "gpuMs": summarize(fs.GPU),
			"target": fmt.Sprintf("%dx%d", fs.W, fs.H),
		}
		res["render"] = r
		detail += fmt.Sprintf("; frames/s %.1f, pacing %v, render call ms %v, gpu ms %v", r["framesPerSec"], r["pacing"], r["renderCallMs"], r["gpuMs"])
	}
	p.setExtra("bench", res)
	p.record("bench", p.render == 0 || fs.Frames > 0, detail, int64(play.secs*1000))
}

// hiddenStep minimises the window for 3s while playing (macOS), to record
// what rendering, mpv's frame drops and playback do while the video can't be
// seen, and that rendering resumes afterwards.
func (p *Player) hiddenStep() {
	if os.Getenv("SPIKE_HIDDEN_STEP") == "" || p.render == 0 {
		return
	}
	c0 := p.readCounters()
	readFrameStats(true)
	t0 := p.num("time-pos")
	p.window.Minimise()
	time.Sleep(3 * time.Second)
	hidden := readFrameStats(true)
	c1 := p.readCounters()
	t1 := p.num("time-pos")
	state := windowState(p)
	p.window.Restore()
	p.window.Focus()
	// Rendering should resume once the window is back on screen (the
	// de-miniaturise animation takes ~0.5s); count frames until 30 arrive.
	d, ok := waitFor(8*time.Second, func() bool { return readFrameStats(false).Frames >= 30 })
	res := map[string]any{
		"stateWhileHidden": state, "rendersWhileHidden": hidden.Renders, "framesWhileHidden": hidden.Frames,
		"vo-drops": c1["frame-drop-count"] - c0["frame-drop-count"], "timePosAdvance": round(t1 - t0),
		"msUntil30FramesAfterRestore": d.Milliseconds(),
	}
	p.setExtra("hidden", res)
	p.record("hidden", ok, fmt.Sprintf("minimised 3s: %v", res), 0)
}
