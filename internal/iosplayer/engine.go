//go:build ios

// Package iosplayer is the iOS playback engine (ADR-0055): libmpv, driven
// through its client API from Go, drawing with the render API into a GLES
// view under the transparent webview (host_ios.m). It implements
// playback.Engine and is handed to the iOS player.Service with
// player.UseEngine; the Service's bound methods, the three events and the
// progress reports are then the desktop's.
//
// Stream URLs carry debrid keys, so no URL is logged or put in an error, and
// mpv's log messages have theirs removed.
package iosplayer

/*
#include "host_ios.h"
*/
import "C"

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/safego"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
	"github.com/k22i/Peli/internal/subsync"
)

// Hardware decoding modes (ADR-0058). The picture always reaches OpenGL ES
// as 8 bits per sample: iOS GLES 3.0 has no 16-bit normalised textures, so
// mpv falls back to integer textures for 10-bit frames, and those drew black
// in the simulator (p010 from the copy variant, and 10-bit software decoding
// alike); a device is unverified, so it isn't relied on.
//
//   - videotoolbox: zero-copy, the default on a device. hwdec-image-format
//     asks VideoToolbox itself for nv12, so 10-bit HEVC comes out 8-bit and
//     maps through mpv's GLES interop (which refuses p010).
//   - videotoolbox-copy: frames copied back to memory, then eightBit. The
//     simulator starts here, since its software GLES can't map any
//     VideoToolbox frame (CVOpenGLESTextureCache error -6683); on a device
//     it is the fallback when a frame won't map.
//   - no: software decoding, then eightBit; the last resort, or the choice
//     when Settings turns hardware decoding off.
const (
	hwVideoToolbox     = "videotoolbox"
	hwVideoToolboxCopy = "videotoolbox-copy"
	hwSoftware         = "no"
)

// eightBit is the filter chain for frames decoded into memory: a deeper
// format (p010, yuv420p10, …) is converted to the nearest 8-bit one; an
// 8-bit frame passes untouched. Zero-copy frames can't go through a filter,
// so that mode runs with no chain.
const eightBit = "lavfi=[format=pix_fmts=nv12|yuv420p|yuvj420p|yuv422p|yuvj422p|yuv444p|yuvj444p|nv21|gray]"

// filterFor is the "vf" a mode runs with.
func filterFor(mode string) string {
	if mode == hwVideoToolbox {
		return ""
	}
	return eightBit
}

// Settings is where a session reads whether to decode on the GPU.
type Settings interface {
	DeviceSettings() (store.DeviceSettings, error)
}

// Engine plays one stream at a time.
type Engine struct {
	window    func() unsafe.Pointer
	sink      playback.Sink
	settings  Settings
	userAgent string
	http      *http.Client

	ops sync.Mutex // Load, Stop, AddSubtitle

	mu sync.Mutex
	// syncRef reads the file playing's own subtitle timing, for lining
	// addon subtitles up with it (Subtitle.AutoSync); synced is how each
	// added track went. A Load replaces both.
	syncRef    *subsync.Pending
	synced     map[int]playback.SubtitleSync
	s          *session
	state      playback.State
	stateDirty bool
	timeDirty  bool
	forceTime  bool
	lastTime   time.Time
	ended      *playback.Ended

	// framing is the framing the file plays with (adjustProps), kept for the
	// crop the video's size completes (applyCrop); videoW and videoH are that
	// size, 0 until mpv reports it and again from every Load.
	framing store.Framing
	videoW  int
	videoH  int

	// loads counts the Loads, so the auto-crop of a file that has gone stops
	// finding bars in the next one (autocrop.go). autoCrop cancels the look
	// at the load autoCropLoad names.
	loads        uint64
	autoCrop     context.CancelFunc
	autoCropLoad uint64

	// trackList is mpv's last raw track-list, and subHidden whether
	// sub-visibility hides the main subtitles: a change to either rebuilds
	// State.Tracks (showTracks), so the tracks reported say the subtitles
	// are off while hidden.
	trackList any
	subHidden bool

	// subScale holds sub-scale at 1 while the main subtitles are pictures,
	// which it would only blur (playback.SubScale).
	subScale playback.SubScale

	// inset is the right margin the picture keeps, in points
	// (SetVideoInset).
	inset int

	// held is set by Suspend until Resume: the app is leaving the screen, the
	// renderer is parked and nothing may start playing meanwhile.
	suspendMu sync.Mutex
	held      bool

	watching    *playback.Watching
	reportWhy   string
	lastReport  time.Time
	reportEvery time.Duration
}

type session struct {
	m       *mpv
	done    chan struct{}
	closing atomic.Bool

	loaded, started  bool
	lastErr, httpErr string
	subDir           string
	// hw is the decoding mode in use; hwSwitched means it was changed for the
	// file already (to the copy variant, or to software), so it isn't again.
	hw         string
	hwSwitched bool
	// What is playing, for a retry in software.
	source     streams.Source
	opts       playback.LoadOptions
	loadedAt   time.Time
	firstFrame bool
	retried    bool
	// awake is whether the screen is being kept on (event loop only).
	awake bool
}

var _ playback.Engine = (*Engine)(nil)

// New returns an Engine that puts its video in the window's view controller
// (window.NativeWindow()) and reports to sink.
func New(window func() unsafe.Pointer, sink playback.Sink, settings Settings, version string) *Engine {
	e := &Engine{
		window: window, sink: sink, settings: settings,
		userAgent:   "Peli/" + version,
		http:        &http.Client{Timeout: playback.SubtitleWait},
		state:       idle(),
		reportEvery: playback.ReportEvery,
	}
	audioTarget.Store(e)
	return e
}

func idle() playback.State {
	return playback.State{
		Volume: 100, Speed: 1, VolumeMax: 100, Tracks: []playback.Track{}, Chapters: []playback.Chapter{},
		SubtitleSize: "medium",
	}
}

// observed are the properties a session observes. The observe id is the
// index + 1.
var observed = []struct {
	name   string
	format mpvFormat
}{
	{"time-pos", fmtDouble},
	{"duration", fmtDouble},
	{"demuxer-cache-duration", fmtDouble},
	{"pause", fmtFlag},
	{"paused-for-cache", fmtFlag},
	// Hidden is how subtitles turn off (SetSubtitleTrack), so the tracks
	// reported follow it.
	{"sub-visibility", fmtFlag},
	{"cache-buffering-state", fmtInt64},
	{"seeking", fmtFlag},
	{"seekable", fmtFlag},
	{"volume", fmtDouble},
	{"mute", fmtFlag},
	{"speed", fmtDouble},
	{"track-list", fmtNode},
	{"chapter-list", fmtNode},
	{"hwdec-current", fmtString},
	{"sub-delay", fmtDouble},
	{"sub-scale", fmtDouble},
	{"sub-text", fmtString},
	{"secondary-sub-text", fmtString},
	{"video-params/hw-pixelformat", fmtString},
	// The video's size, for the framing's crop (applyCrop), and the sound's
	// delay, the sheet's readout. Appended, so the observe ids above don't
	// move.
	{"video-params/w", fmtInt64},
	{"video-params/h", fmtInt64},
	{"audio-delay", fmtDouble},
}

// mapFailed are the log lines that say a zero-copy frame couldn't be drawn:
// mpv refusing the format, or the texture cache refusing the buffer.
var mapFailed = []string{"Format unsupported", "Mapping hardware decoded surface failed"}

// options are set on every session before mpv_initialize.
var options = [][2]string{
	{"vo", "libmpv"}, {"ao", "audiounit"},
	{"idle", "yes"}, {"force-window", "no"}, {"keep-open", "no"},
	{"osd-level", "0"},
	{"input-default-bindings", "no"}, {"input-vo-keyboard", "no"}, {"input-cursor", "no"},
	{"background-color", "#000000"},
	{"subs-match-os-language", "no"},
	// sub-auto off: the player picks tracks itself and adds addons' subtitles.
	{"sub-auto", "no"},
	// The second line is drawn by the screen (State.SecondarySubtitleText).
	{"secondary-sub-visibility", "no"},
	{"audio-format", "float"},
	// VideoToolbox's output in zero-copy mode: 8-bit, see hwVideoToolbox.
	{"hwdec-image-format", "nv12"},
	// A phone has less memory than a Mac: a debrid link needs a minute of
	// read-ahead at most.
	{"demuxer-max-bytes", "64MiB"}, {"demuxer-max-back-bytes", "32MiB"},
	{"cache-secs", "90"},
}

// hwdec is the mode a file starts in, chosen before its first frame.
func (e *Engine) hwdec() string {
	if e.settings != nil {
		if d, err := e.settings.DeviceSettings(); err != nil {
			slog.Warn("iosplayer: device settings unread", "error", err)
		} else if !d.HardwareDecoding {
			return hwSoftware
		}
	}
	// $PELI_HWDEC picks the start mode, for trying the fallbacks.
	switch m := os.Getenv("PELI_HWDEC"); m {
	case hwVideoToolbox, hwVideoToolboxCopy, hwSoftware:
		return m
	}
	if C.peli_is_simulator() != 0 {
		return hwVideoToolboxCopy
	}
	return hwVideoToolbox
}

// Load plays source, opening a session if none is open, or replacing what
// the open one plays.
func (e *Engine) Load(source streams.Source, opts playback.LoadOptions) error {
	if source.URL == "" || !opts.Valid() {
		return playback.ErrInvalid
	}
	e.ops.Lock()
	defer e.ops.Unlock()
	mode := e.hwdec()
	ses, err := e.open(mode)
	if err != nil {
		return err
	}
	e.send(e.stopReport())
	ses.retried = false
	// A retry in software (loadFile again) keeps the file's reference.
	e.startSync(source)
	return e.loadFile(ses, source, opts, mode)
}

// loadFile starts source in ses with hardware decoding mode hw.
func (e *Engine) loadFile(ses *session, source streams.Source, opts playback.LoadOptions, hw string) error {
	var watching *playback.Watching
	if opts.Watching != nil {
		w := *opts.Watching
		watching = &w
	}
	props0 := [][2]string{{"pause", "no"}}
	// A download's file (Origin "download:<id>", ADR-0064) is a path on the
	// disk: no request headers or user agent to set.
	if !strings.HasPrefix(source.Origin, "download:") {
		userAgent := source.UserAgent
		if userAgent == "" {
			userAgent = e.userAgent
		}
		// Set as a list: a header's value may hold a comma.
		if err := ses.m.setStringList("http-header-fields", source.HeaderFields()); err != nil {
			return notPlaying(err)
		}
		props0 = append(props0, [2]string{"user-agent", userAgent})
	}
	// Changing hwdec makes mpv re-initialise the decoder: only when it
	// differs. The filter goes first, so no deep frame reaches the screen.
	if hw != ses.hw {
		props0 = append(props0, [2]string{"vf", filterFor(hw)}, [2]string{"hwdec", hw})
	}
	for _, p := range props0 {
		if err := ses.m.setProperty(p[0], p[1]); err != nil {
			return notPlaying(err)
		}
	}
	e.mu.Lock()
	props := e.subScale.Load(playback.TrackProps(opts, osCaptions(), playback.IOSFonts))
	e.mu.Unlock()
	props = append(props, [2]string{"speed", "1"}, [2]string{"sub-delay", "0"})
	for _, p := range props {
		if err := ses.m.setProperty(p[0], p[1]); err != nil {
			return notPlaying(err)
		}
	}
	// The file's picture, framing, quality, sound and audio delay: what its
	// title or this device asks for, or what opts names. A property or filter
	// this build lacks isn't worth failing the file over, so it is logged
	// instead: with af, the sound as the track is rather than silent.
	for _, p := range e.adjustProps(opts) {
		err := ses.m.setProperty(p[0], p[1])
		if err != nil && p[0] == "af" {
			err = ses.m.setProperty("af", "")
		}
		if err != nil {
			slog.Warn("iosplayer: adjustment not set", "property", p[0], "error", err)
		}
	}
	ses.hw, ses.hwSwitched, ses.firstFrame = hw, false, false
	ses.source, ses.opts, ses.loadedAt = source, opts, time.Now()
	// The last file's look for bars goes before this one loads; the new
	// file's framing starts one again once its size is known (applyCrop).
	// Not inside the update below, which holds e.mu.
	e.stopAutoCrop()
	e.update(func(st *playback.State) {
		st.Loading, st.Buffering, st.BufferPercent, st.Seeking, st.Seekable = true, false, 0, false, false
		st.Time = playback.Time{Position: opts.Start}
		st.Tracks, st.Chapters = []playback.Track{}, []playback.Chapter{}
		// The new file's track-list replaces these; until it comes, nothing
		// is left of the last one's tracks to show.
		e.trackList, e.subHidden = nil, false
		// So the last file's size can't crop this one: mpv reports the new
		// size before its first frame.
		e.videoW, e.videoH = 0, 0
		// Nor can its auto-crop: the bars found belong to the file that
		// went.
		e.loads++
		st.AutoCrop = nil
		e.watching, e.reportWhy, e.lastReport = watching, "", time.Now()
	})
	args := []string{"loadfile", source.URL, "replace"}
	if opts.Start > 0 {
		args = append(args, "-1", "start="+playback.Seconds(opts.Start))
	}
	if err := ses.m.command(args...); err != nil {
		e.update(func(st *playback.State) { st.Loading = false })
		return notPlaying(err)
	}
	return nil
}

// open returns the open session, or opens one that starts in mode. ops
// must be held.
func (e *Engine) open(mode string) (*session, error) {
	e.mu.Lock()
	ses := e.s
	e.mu.Unlock()
	if ses != nil {
		return ses, nil
	}
	vc := e.window()
	if vc == nil {
		return nil, fmt.Errorf("%w: no window for the video", playback.ErrUnavailable)
	}
	// .playback, so sound plays with the silent switch on.
	if rc := C.peli_audio_session(); rc != 0 {
		slog.Warn("iosplayer: audio session not set", "step", int(rc))
	}
	m, err := mpvCreate()
	if err != nil {
		return nil, fmt.Errorf("%w: %w", playback.ErrUnavailable, err)
	}
	ses = &session{m: m, done: make(chan struct{}), hw: mode}
	fail := func(err error) (*session, error) {
		close(ses.done)
		m.destroy()
		return nil, fmt.Errorf("%w: %w", playback.ErrUnavailable, err)
	}
	for _, o := range options {
		if err := m.setOptionString(o[0], o[1]); err != nil {
			slog.Warn("iosplayer: option not set", "error", err)
		}
	}
	for _, o := range [][2]string{{"hwdec", ses.hw}, {"vf", filterFor(ses.hw)}} {
		if err := m.setOptionString(o[0], o[1]); err != nil {
			slog.Warn("iosplayer: option not set", "error", err)
		}
	}
	// The chroma hook (chroma.go) is set in every mode: zero-copy needs it,
	// and it is right for the copy and software modes too, so switching
	// modes mid-file needs nothing more.
	if path, err := chromaShader(); err != nil {
		slog.Warn("iosplayer: chroma shader not written", "error", err)
	} else if err := m.setOptionString("glsl-shaders", path); err != nil {
		slog.Warn("iosplayer: option not set", "error", err)
	}
	// $PELI_MPV_OPTIONS ("hwdec=no") overrides any of these, for debugging.
	for _, o := range strings.Fields(os.Getenv("PELI_MPV_OPTIONS")) {
		name, value, ok := strings.Cut(o, "=")
		if !ok {
			value = "yes"
		}
		if err := m.setOptionString(name, value); err != nil {
			slog.Warn("iosplayer: option not set", "error", err)
		}
	}
	if err := m.initialize(); err != nil {
		return fail(fmt.Errorf("mpv_initialize: %w", err))
	}
	for i, o := range observed {
		if err := m.observe(uint64(i+1), o.name, o.format); err != nil {
			return fail(fmt.Errorf("observe %s: %w", o.name, err))
		}
	}
	// "v": at "warn", libmpv drops FFmpeg's "HTTP error 403" (an expired
	// link) and the VideoToolbox interop's complaints.
	if err := m.requestLogMessages("v"); err != nil {
		return fail(err)
	}
	safego.Go("iosplayer: events", func() { e.loop(ses) })
	// The render context must exist before the first loadfile.
	if rc := C.peli_host_attach(vc, unsafe.Pointer(m.handle())); rc != 0 {
		e.closeSession(ses)
		return nil, fmt.Errorf("%w: video host step %d", playback.ErrUnavailable, int(rc))
	}
	e.mu.Lock()
	e.s = ses
	e.state = idle()
	e.state.Active = true
	e.stateDirty = true
	e.mu.Unlock()
	e.applyInset()
	return ses, nil
}

// Stop ends the session, and gives the screen its own brightness back.
func (e *Engine) Stop() error {
	C.peli_brightness_restore()
	e.ops.Lock()
	defer e.ops.Unlock()
	e.mu.Lock()
	ses := e.s
	e.mu.Unlock()
	if ses == nil {
		return nil
	}
	e.send(e.stopReport())
	e.closeSession(ses)
	e.mu.Lock()
	e.s = nil
	e.watching = nil
	// The closed file's track list (mpv's raw node tree, copied into Go) and
	// its size go with it; nothing of the session it came from is kept.
	e.trackList, e.subHidden = nil, false
	e.videoW, e.videoH = 0, 0
	e.state = idle()
	e.mu.Unlock()
	e.flush(nil)
	return nil
}

// closeSession follows the binding rules from M0: stop the event loop, free
// the render context (detach), then destroy the handle. Stop goes through
// here, so no look for bars is left with a handle going away.
//
// A session's native memory, and where each part of it goes:
//
//   - the decoder's frame pools and reference frames, its filter graph and
//     the demuxer cache, inside the handle (a 3840x2160 10-bit software
//     play is 300 MiB or more of it). The unload below ends the file while
//     mpv can still act on it, and mpv_terminate_destroy frees the rest;
//     iOS's allocator hands freed pages back to the process's footprint
//     straight away (measured: 500 MiB freed drops to 2 MiB on the iOS
//     runtime, the same memory stays counted on macOS);
//   - mpv's GL textures, shaders and buffers: with the render context, in
//     detach;
//   - this host's framebuffer, renderbuffer and the layer's drawable, and
//     the EAGL context that made them: in detach too (releaseGL);
//   - the audio output's I/O thread and buffers: peli_audio_release, below.
//
// The footprint on either side of the teardown is logged, so a device's log
// says whether closing a session gave its memory back (ios/README.md).
func (e *Engine) closeSession(ses *session) {
	e.stopAutoCrop()
	e.stopSync()
	// A file that still plays is ended while mpv is alive, as the desktop
	// player does: the decoder, the filter graph and the demuxer cache go
	// here rather than inside mpv_terminate_destroy, which then has no
	// decoding to join and no frame in flight to wait for.
	_ = ses.m.command("stop")
	ses.closing.Store(true)
	ses.m.wakeup()
	<-ses.done
	before := C.peli_footprint()
	C.peli_host_detach()
	C.peli_host_awake(0)
	ses.m.destroy()
	if ses.subDir != "" {
		os.RemoveAll(ses.subDir)
	}
	// The player's claim on the sound goes: the audio output's thread and
	// buffers with it, and another app's audio can have the route back. The
	// next play takes the session again (peli_audio_session, in open).
	if rc := C.peli_audio_release(); rc != 0 {
		slog.Warn("iosplayer: audio session not released", "step", int(rc))
	}
	slog.Info("iosplayer: session closed",
		"footprint_before_detach_mib", megabytes(before),
		"footprint_after_destroy_mib", megabytes(C.peli_footprint()),
		"handles", liveHandles.Load())
}

// megabytes is b (a byte count from C) in whole MiB, for the log lines.
func megabytes(b C.ulonglong) int64 { return int64(b) / (1 << 20) }

func (e *Engine) current() *session {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.s
}

func notPlaying(err error) error {
	if errors.Is(err, errDestroyed) {
		return playback.ErrNotPlaying
	}
	return err
}

func (e *Engine) Snapshot() playback.State {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.copyState()
}

func (e *Engine) copyState() playback.State {
	st := e.state
	st.Tracks = append([]playback.Track{}, st.Tracks...)
	st.Chapters = append([]playback.Chapter{}, st.Chapters...)
	return st
}

func (e *Engine) set(name, value string) error {
	ses := e.current()
	if ses == nil {
		return playback.ErrNotPlaying
	}
	return notPlaying(ses.m.setProperty(name, value))
}

func (e *Engine) command(args ...string) error {
	ses := e.current()
	if ses == nil {
		return playback.ErrNotPlaying
	}
	return notPlaying(ses.m.command(args...))
}

func finite(f float64) bool { return !math.IsNaN(f) && !math.IsInf(f, 0) }

func (e *Engine) SetPaused(paused bool) error { return e.set("pause", playback.YesNo(paused)) }

func (e *Engine) Seek(position float64) error {
	if position < 0 || !finite(position) {
		return playback.ErrInvalid
	}
	return e.command("seek", playback.Seconds(position), "absolute")
}

func (e *Engine) SeekBy(delta float64) error {
	if !finite(delta) {
		return playback.ErrInvalid
	}
	return e.command("seek", playback.Seconds(delta), "relative")
}

func (e *Engine) Scrub(position float64) error {
	if position < 0 || !finite(position) {
		return playback.ErrInvalid
	}
	return e.command("seek", playback.Seconds(position), "absolute+keyframes")
}

func (e *Engine) SetVolume(volume float64) error {
	if volume < 0 || volume > 100 || math.IsNaN(volume) {
		return playback.ErrInvalid
	}
	return e.set("volume", playback.Seconds(volume))
}

// SetPanscan crops the picture to fill the screen: 0 shows it whole, 1
// fills (mpv's panscan; the touch player's pinch, #131).
func (e *Engine) SetPanscan(v float64) error {
	if math.IsNaN(v) || v < 0 || v > 1 {
		return playback.ErrInvalid
	}
	return e.set("panscan", playback.Seconds(v))
}

// SetVideoInset shifts the picture left by rightPx points, for the docked
// watch party's sidebar; 0 puts it back. mpv's margin is a share of the
// width (the view's, clamped to 0.6), so the frontend calls it again when
// the view's width changes, and a new session gets it too. Only the picture
// moves: the GLES framebuffer stays the view's size.
func (e *Engine) SetVideoInset(rightPx int) error {
	e.mu.Lock()
	e.inset = max(rightPx, 0)
	e.mu.Unlock()
	e.applyInset()
	return nil
}

func (e *Engine) applyInset() {
	ses := e.current()
	if ses == nil {
		return
	}
	e.mu.Lock()
	inset := e.inset
	e.mu.Unlock()
	ratio := 0.0
	if w := float64(C.peli_host_width()); inset > 0 && w > 0 {
		ratio = math.Min(float64(inset)/w, 0.6)
	}
	if err := ses.m.setProperty("video-margin-ratio-right", strconv.FormatFloat(ratio, 'f', 4, 64)); err != nil {
		slog.Warn("iosplayer: video inset not set", "error", err)
	}
}

func (e *Engine) SetMuted(muted bool) error { return e.set("mute", playback.YesNo(muted)) }

func (e *Engine) SetSpeed(speed float64) error {
	if speed < 0.25 || speed > 4 || math.IsNaN(speed) {
		return playback.ErrInvalid
	}
	return e.set("speed", playback.Seconds(speed))
}

func (e *Engine) SetAudioTrack(id int) error {
	if id < 1 {
		return playback.ErrInvalid
	}
	return e.set("aid", strconv.Itoa(id))
}

// SetSubtitleTrack shows the subtitle track with id, or none for 0.
//
// Off hides the subtitles rather than deselecting them: mpv 0.41 refresh-seeks
// on sid=no, dropping every buffered packet and re-reading from the network,
// so a streamed file stalls until that's done. Kept, the same track is one
// property away from being back on.
func (e *Engine) SetSubtitleTrack(id int) error {
	if id < 0 {
		return playback.ErrInvalid
	}
	ses := e.current()
	if ses == nil {
		return playback.ErrNotPlaying
	}
	sid, err := ses.m.getString("sid")
	if err != nil {
		return notPlaying(err)
	}
	if id == 0 {
		// Nothing selected: there's nothing to hide.
		if sid == "no" {
			return nil
		}
		return e.set("sub-visibility", "no")
	}
	// Already this track, just hidden: showing it again asks mpv for
	// nothing.
	if sid == strconv.Itoa(id) {
		return e.set("sub-visibility", "yes")
	}
	// The same track can't be both: the second line gives way.
	if e.Snapshot().SecondaryIs(id) {
		if err := e.set("secondary-sid", "no"); err != nil {
			return err
		}
	}
	if err := e.set("sid", strconv.Itoa(id)); err != nil {
		return err
	}
	return e.set("sub-visibility", "yes")
}

func (e *Engine) SetSecondarySubtitleTrack(id int) error {
	switch {
	case id < 0:
		return playback.ErrInvalid
	case id == 0:
		return e.set("secondary-sid", "no")
	}
	st := e.Snapshot()
	var track *playback.Track
	for i := range st.Tracks {
		if st.Tracks[i].ID == id && st.Tracks[i].Type == "sub" {
			track = &st.Tracks[i]
		}
	}
	if track == nil || track.Selected || playback.ImageSubtitle(track.Codec) {
		return playback.ErrInvalid
	}
	return e.set("secondary-sid", strconv.Itoa(id))
}

func (e *Engine) SetSubtitleDelay(delay float64) error {
	if math.IsNaN(delay) || math.Abs(delay) > playback.MaxSubtitleDelay {
		return playback.ErrInvalid
	}
	return e.set("sub-delay", playback.Seconds(delay))
}

func (e *Engine) SetSubtitleSize(size string) error {
	scale, ok := playback.SubtitleScales[size]
	if !ok {
		return playback.ErrInvalid
	}
	e.mu.Lock()
	p := e.subScale.Props([][2]string{{"sub-scale", playback.Seconds(scale)}})[0]
	e.mu.Unlock()
	return e.set(p[0], p[1])
}

func (e *Engine) SetSubtitleStyle(style playback.SubtitleStyle) error {
	if !style.Valid() {
		return playback.ErrInvalid
	}
	e.mu.Lock()
	props := e.subScale.Props(playback.StyleProps(style, playback.IOSFonts))
	e.mu.Unlock()
	for _, p := range props {
		if err := e.set(p[0], p[1]); err != nil {
			return err
		}
	}
	return nil
}

// SetNowPlaying is Phase 6's (lock-screen controls); the call is accepted.
func (e *Engine) SetNowPlaying(playback.NowPlaying) error { return nil }

func osCaptions() bool { return C.peli_system_captions() != 0 }

// SystemCaptions reports whether iOS asks for captions.
func (e *Engine) SystemCaptions() bool { return osCaptions() }

// AddSubtitle downloads sub and adds it as an external track, and shows it.
//
// A file:// URL is a subtitle saved with a download (ADR-0064): the player
// Service has checked that it's inside a download's subs folder (see
// player/localsubtitle.go), and mpv reads it from disk, with no copy.
func (e *Engine) AddSubtitle(ctx context.Context, sub playback.Subtitle) (int, error) {
	u, err := url.Parse(sub.URL)
	if err == nil && u.Scheme == "file" {
		return e.addLocalSubtitle(u.Path, sub)
	}
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" ||
		!playback.LanguageValid(sub.Lang) {
		return 0, playback.ErrInvalid
	}
	if e.current() == nil {
		return 0, playback.ErrNotPlaying
	}
	data, err := playback.DownloadSubtitle(ctx, e.http, e.userAgent, u)
	if err != nil {
		return 0, err
	}
	// Lined up with the file's own subtitles first (before ops: it may
	// wait a few seconds for their timing).
	var synced playback.SubtitleSync
	e.mu.Lock()
	ref := e.syncRef
	e.mu.Unlock()
	if sub.AutoSync {
		data, synced = playback.SyncSubtitle(ctx, ref, data, sub.Lang)
	}
	e.ops.Lock()
	defer e.ops.Unlock()
	ses := e.current()
	if ses == nil {
		return 0, playback.ErrNotPlaying
	}
	e.mu.Lock()
	stale := e.syncRef != ref
	e.mu.Unlock()
	if stale {
		// Another file loaded meanwhile: these were for the last one.
		return 0, playback.ErrNotPlaying
	}
	if ses.subDir == "" {
		dir, err := os.MkdirTemp("", "peli-subtitles-")
		if err != nil {
			return 0, fmt.Errorf("%w: %w", playback.ErrSubtitles, err)
		}
		ses.subDir = dir
	}
	f, err := os.CreateTemp(ses.subDir, "*"+playback.SubtitleExt(u))
	if err != nil {
		return 0, fmt.Errorf("%w: %w", playback.ErrSubtitles, err)
	}
	_, err = f.Write(data)
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return 0, fmt.Errorf("%w: %w", playback.ErrSubtitles, err)
	}
	flags := "select"
	if sub.Secondary {
		flags = "auto"
	}
	if err := ses.m.command("sub-add", f.Name(), flags, sub.Title, sub.Lang); err != nil {
		if errors.Is(err, errDestroyed) {
			return 0, playback.ErrNotPlaying
		}
		return 0, fmt.Errorf("%w: %w", playback.ErrSubtitles, err)
	}
	id, err := addedTrack(ses.m, f.Name())
	if err != nil {
		return 0, fmt.Errorf("%w: %w", playback.ErrSubtitles, err)
	}
	if sub.AutoSync {
		e.mu.Lock()
		if e.synced == nil {
			e.synced = map[int]playback.SubtitleSync{}
		}
		e.synced[id] = synced
		e.mu.Unlock()
	}
	if sub.Secondary {
		if err := ses.m.setProperty("secondary-sid", strconv.Itoa(id)); err != nil {
			return 0, fmt.Errorf("%w: %w", playback.ErrSubtitles, err)
		}
		return id, nil
	}
	// Shown even when sub-visibility hid the file's own subtitles.
	if err := ses.m.setProperty("sub-visibility", "yes"); err != nil {
		return 0, fmt.Errorf("%w: %w", playback.ErrSubtitles, err)
	}
	return id, nil
}

// addLocalSubtitle adds the subtitle file at file, already checked by the
// caller, as an external track.
func (e *Engine) addLocalSubtitle(file string, sub playback.Subtitle) (int, error) {
	if !playback.LanguageValid(sub.Lang) || !filepath.IsAbs(file) {
		return 0, playback.ErrInvalid
	}
	if e.current() == nil {
		return 0, playback.ErrNotPlaying
	}
	e.ops.Lock()
	defer e.ops.Unlock()
	ses := e.current()
	if ses == nil {
		return 0, playback.ErrNotPlaying
	}
	flags := "select"
	if sub.Secondary {
		flags = "auto"
	}
	if err := ses.m.command("sub-add", file, flags, sub.Title, sub.Lang); err != nil {
		if errors.Is(err, errDestroyed) {
			return 0, playback.ErrNotPlaying
		}
		return 0, fmt.Errorf("%w: %w", playback.ErrSubtitles, err)
	}
	id, err := addedTrack(ses.m, file)
	if err != nil {
		return 0, fmt.Errorf("%w: %w", playback.ErrSubtitles, err)
	}
	if sub.Secondary {
		if err := ses.m.setProperty("secondary-sid", strconv.Itoa(id)); err != nil {
			return 0, fmt.Errorf("%w: %w", playback.ErrSubtitles, err)
		}
		return id, nil
	}
	// Shown even when sub-visibility hid the file's own subtitles.
	if err := ses.m.setProperty("sub-visibility", "yes"); err != nil {
		return 0, fmt.Errorf("%w: %w", playback.ErrSubtitles, err)
	}
	return id, nil
}

func addedTrack(m *mpv, file string) (int, error) {
	count, err := m.getString("track-list/count")
	if err != nil {
		return 0, err
	}
	n, _ := strconv.Atoi(count)
	for i := n - 1; i >= 0; i-- {
		prefix := "track-list/" + strconv.Itoa(i) + "/"
		if name, _ := m.getString(prefix + "external-filename"); name != file {
			continue
		}
		id, err := m.getString(prefix + "id")
		if err != nil {
			return 0, err
		}
		return strconv.Atoi(id)
	}
	return 0, errors.New("added track not in the track list")
}

// update changes the state and has the event loop send it.
func (e *Engine) update(change func(*playback.State)) {
	e.mu.Lock()
	change(&e.state)
	e.stateDirty = true
	ses := e.s
	e.mu.Unlock()
	if ses != nil {
		ses.m.wakeup()
	} else {
		e.flush(nil)
	}
}

// --- the event loop ---------------------------------------------------------

func (e *Engine) loop(ses *session) {
	defer close(ses.done)
	timeout := -1.0
	for {
		ev := ses.m.waitEvent(timeout)
		switch ev.ID {
		case eventShutdown:
			return
		case eventNone:
			if ses.closing.Load() {
				return
			}
			timeout = e.flush(ses)
		default:
			e.handle(ses, ev)
			timeout = 0
		}
	}
}

func (e *Engine) handle(ses *session, ev mpvEvent) {
	switch ev.ID {
	case eventPropertyChange:
		e.property(ses, ev.Prop, ev.Value)
	case eventStartFile:
		ses.lastErr, ses.httpErr = "", ""
		ses.started = false
	case eventFileLoaded:
		ses.loaded = true
	case eventPlaybackRestart:
		e.mu.Lock()
		e.state.Loading = false
		e.stateDirty, e.timeDirty, e.forceTime = true, true, true
		if ses.started {
			e.due(playback.ReportSeeked)
		} else {
			e.due(playback.ReportStarted)
			if !ses.firstFrame {
				ses.firstFrame = true
				// What plays, for the coverage notes (no URLs in it).
				info := map[string]string{}
				for _, k := range []string{"video-codec", "video-format", "video-params/pixelformat", "video-params/hw-pixelformat",
					"video-params/gamma", "video-params/primaries", "width", "height", "audio-codec-name", "audio-params/channel-count", "file-format"} {
					info[k], _ = ses.m.getString(k)
				}
				time.AfterFunc(4*time.Second, func() { e.logTracks(ses) })
				safego.Go("iosplayer: stats", func() { e.logStats(ses) })
				slog.Info("iosplayer: first frame", "ms", time.Since(ses.loadedAt).Milliseconds(), "hwdec", ses.hw, "current", e.state.HWDec, "info", info)
			}
		}
		ses.started = true
		e.mu.Unlock()
	case eventEndFile:
		if ev.Reason != "eof" && ev.Reason != "error" {
			return
		}
		ses.loaded = false
		ended := &playback.Ended{Reason: ev.Reason}
		if ev.Reason == "error" {
			if e.retryInSoftware(ses) {
				return
			}
			ended.Code, ended.Message = endCode(mpvError(ev.Error), ses.httpErr), mpvError(ev.Error).Error()
			slog.Warn("iosplayer: file failed", "code", ended.Code, "error", ended.Message, "detail", ses.lastErr)
		}
		e.mu.Lock()
		e.state.Loading, e.state.Buffering, e.state.Seeking = false, false, false
		e.stateDirty, e.ended = true, ended
		if ev.Reason == "eof" && e.state.Duration > 0 {
			e.state.Position = e.state.Duration
		}
		e.due(playback.ReportEnded)
		e.mu.Unlock()
	case eventLogMessage:
		text := playback.RedactURLs(strings.TrimSpace(ev.Text))
		if playback.ExpiredLog(text) {
			ses.httpErr = text
		}
		// A zero-copy frame that won't map: copy frames back instead.
		if ses.hw == hwVideoToolbox && !ses.hwSwitched {
			for _, f := range mapFailed {
				if strings.Contains(text, f) {
					e.switchHW(ses, hwVideoToolboxCopy, f)
					break
				}
			}
		}
		if ev.Level == "error" || ev.Level == "fatal" {
			ses.lastErr = text
			slog.Warn("mpv: "+text, "module", ev.Prefix)
		} else {
			slog.Debug("mpv: "+text, "module", ev.Prefix, "level", ev.Level)
		}
	}
}

// switchHW changes the decoding mode of the file playing: the fallback for
// a zero-copy frame that won't map (the mode is otherwise chosen before the
// first frame), once per file. mpv re-initialises the decoder and seeks back
// to where it was. The 8-bit filter goes in first, so no deep frame reaches
// the screen. In the simulator a failed mapping leaves its software GLES
// drawing broken frames until the simulator reboots, switch or no switch
// (ADR-0058), so this path is unverified there; it is why the simulator
// starts in copy mode.
func (e *Engine) switchHW(ses *session, mode, why string) {
	if ses.hwSwitched {
		return
	}
	ses.hwSwitched = true
	if err := ses.m.setProperty("vf", filterFor(mode)); err != nil {
		slog.Warn("iosplayer: filter not changed", "error", err)
		return
	}
	if err := ses.m.setProperty("hwdec", mode); err != nil {
		slog.Warn("iosplayer: hwdec not changed", "error", err)
		return
	}
	slog.Info("iosplayer: hwdec changed", "from", ses.hw, "to", mode, "why", why)
	ses.hw = mode
}

// retryInSoftware reloads a file that failed in hardware, before its first
// frame, in software, once. It reports whether it did.
func (e *Engine) retryInSoftware(ses *session) bool {
	if ses.retried || ses.started || ses.hw == hwSoftware || ses.httpErr != "" {
		return false
	}
	ses.retried = true
	slog.Info("iosplayer: retrying in software", "hwdec", ses.hw)
	e.mu.Lock()
	pos := e.state.Position
	e.mu.Unlock()
	opts := ses.opts
	if pos > opts.Start {
		opts.Start = pos
	}
	go func() {
		e.ops.Lock()
		defer e.ops.Unlock()
		if e.current() != ses {
			return
		}
		if err := e.loadFile(ses, ses.source, opts, hwSoftware); err != nil {
			slog.Warn("iosplayer: software retry failed", "error", err)
		}
	}()
	return true
}

func (e *Engine) property(ses *session, name string, v any) {
	if name == "video-params/hw-pixelformat" {
		if px, _ := v.(string); px == "p010" && ses.hw == hwVideoToolbox && !ses.hwSwitched {
			e.switchHW(ses, hwVideoToolboxCopy, "p010")
		}
		return
	}
	// The video's size, which no state carries: it completes the framing's
	// crop. Not under e.mu, since applyCrop takes it.
	if name == "video-params/w" || name == "video-params/h" {
		e.mu.Lock()
		if name == "video-params/w" {
			e.videoW = int(playback.Number(v))
		} else {
			e.videoH = int(playback.Number(v))
		}
		w, h := e.videoW, e.videoH
		e.mu.Unlock()
		if w > 0 && h > 0 {
			e.applyCrop(ses)
		}
		return
	}
	if name == "track-list" {
		e.mu.Lock()
		e.trackList = v
		e.showTracks(&e.state)
		e.stateDirty = true
		// Picture subtitles are drawn at their own size (playback.SubScale).
		scale, changed := e.subScale.Tracks(playback.TracksFrom(v))
		e.mu.Unlock()
		if changed {
			if err := ses.m.setProperty("sub-scale", scale); err != nil {
				slog.Warn("iosplayer: subtitle scale not set", "error", err)
			}
		}
		return
	}
	e.mu.Lock()
	defer e.mu.Unlock()
	st := &e.state
	switch name {
	case "time-pos":
		st.Position = playback.Number(v)
		e.timeDirty = true
		return
	case "duration":
		st.Duration = playback.Number(v)
		e.timeDirty = true
		return
	case "demuxer-cache-duration":
		st.Buffered = playback.Number(v)
		e.timeDirty = true
		return
	case "pause":
		paused, _ := v.(bool)
		if paused && !st.Paused && ses.loaded {
			e.due(playback.ReportPaused)
		}
		if !paused && st.Paused && ses.loaded && ses.started {
			e.due(playback.ReportResumed)
		}
		st.Paused = paused
	case "paused-for-cache":
		st.Buffering, _ = v.(bool)
	case "cache-buffering-state":
		st.BufferPercent = int(playback.Number(v))
	case "seeking":
		st.Seeking, _ = v.(bool)
	case "seekable":
		st.Seekable, _ = v.(bool)
	case "volume":
		st.Volume = playback.Number(v)
	case "mute":
		st.Muted, _ = v.(bool)
	case "speed":
		st.Speed = playback.Number(v)
	case "sub-visibility":
		// mpv's property is true when the subtitles show: the field is
		// the other way round.
		visible, _ := v.(bool)
		e.subHidden = !visible
		if e.trackList != nil {
			e.showTracks(st)
		}
	case "chapter-list":
		st.Chapters = playback.ChaptersFrom(v)
	case "hwdec-current":
		st.HWDec, _ = v.(string)
		if st.HWDec == hwSoftware {
			st.HWDec = ""
		}
	case "sub-delay":
		st.SubtitleDelay = math.Round(playback.Number(v)*1000) / 1000
	case "audio-delay":
		st.AudioDelay = math.Round(playback.Number(v)*1000) / 1000
	case "sub-scale":
		// Held at 1 for picture subtitles, it isn't the size asked for.
		if !e.subScale.Image() {
			st.SubtitleSize = playback.SubtitleSizeName(playback.Number(v))
		}
	case "sub-text":
		st.SubtitleText, _ = v.(string)
	case "secondary-sub-text":
		st.SecondarySubtitleText, _ = v.(string)
	}
	e.stateDirty = true
}

// showTracks rebuilds State.Tracks from mpv's last track-list, with the main
// subtitle track unselected while sub-visibility hides it. Call with e.mu
// held.
func (e *Engine) showTracks(st *playback.State) {
	st.Tracks = playback.TracksFrom(e.trackList)
	if e.subHidden {
		st.Tracks = playback.HideMainSubtitle(st.Tracks)
	}
}

// flush sends what changed: the state, the time (throttled), an end and a
// report. It returns how long the loop may wait for events, -1 for as long
// as it takes. A nil ses means there's no loop: send now.
func (e *Engine) flush(ses *session) float64 {
	now := time.Now()
	wait := -1.0
	e.mu.Lock()
	var state *playback.State
	if e.stateDirty {
		st := e.copyState()
		state, e.stateDirty = &st, false
	}
	var t *playback.Time
	if e.timeDirty {
		if since := now.Sub(e.lastTime); e.forceTime || since >= playback.TimeEvery {
			tm := e.state.Time
			t, e.timeDirty, e.forceTime, e.lastTime = &tm, false, false, now
		} else {
			wait = (playback.TimeEvery - since).Seconds()
		}
	}
	ended := e.ended
	e.ended = nil
	playing := ses != nil && ses.loaded && !e.state.Paused
	if e.reportWhy == "" && playing && !e.state.Loading && now.Sub(e.lastReport) >= e.reportEvery {
		e.reportWhy = playback.ReportPlaying
	}
	var report *playback.Report
	if e.reportWhy != "" {
		report = e.reportNow(e.reportWhy)
		e.reportWhy, e.lastReport = "", now
	}
	e.mu.Unlock()

	if ses != nil && playing != ses.awake {
		ses.awake = playing
		// Keeps the screen awake while a picture plays.
		if playing {
			C.peli_host_awake(1)
		} else {
			C.peli_host_awake(0)
		}
	}
	if state != nil {
		e.sink.State(*state)
	}
	if t != nil {
		e.sink.Time(*t)
	}
	if ended != nil {
		e.sink.Ended(*ended)
	}
	e.send(report)
	return wait
}

// --- progress reports (#64) ---------------------------------------------------

func (e *Engine) due(why string) {
	if e.reportWhy == "" || e.reportWhy == playback.ReportPlaying {
		e.reportWhy = why
	}
}

func (e *Engine) reportNow(why string) *playback.Report {
	if e.watching == nil || e.state.Duration <= 0 {
		return nil
	}
	return &playback.Report{
		Watching: *e.watching,
		Position: min(max(e.state.Position, 0), e.state.Duration),
		Duration: e.state.Duration,
		Why:      why,
	}
}

// stopReport is the report for a file being stopped or replaced. A file
// still loading reports nothing: its position is the start it was asked for.
func (e *Engine) stopReport() *playback.Report {
	e.mu.Lock()
	defer e.mu.Unlock()
	if e.state.Loading {
		return nil
	}
	return e.reportNow(playback.ReportStopped)
}

func (e *Engine) send(r *playback.Report) {
	if r != nil {
		e.sink.Report(*r)
	}
}

func endCode(err mpvError, httpErr string) string {
	switch {
	case httpErr != "":
		return playback.EndExpired
	case err == errUnknownFormat || err == errNothingToPlay:
		return playback.EndUnsupported
	}
	return playback.EndFailed
}

// logTracks writes what the file offers and what is selected, for the
// coverage notes: codecs and languages only.
func (e *Engine) logTracks(ses *session) {
	if e.current() != ses {
		return
	}
	st := e.Snapshot()
	var parts []string
	for _, t := range st.Tracks {
		mark := ""
		if t.Selected {
			mark = "*"
		}
		parts = append(parts, fmt.Sprintf("%s%d:%s/%s/%s", mark, t.ID, t.Type, t.Codec, t.Lang))
	}
	slog.Info("iosplayer: tracks", "position", st.Position, "hwdec", st.HWDec, "list", strings.Join(parts, " "))
}

// --- leaving the screen, interruptions and route changes (ADR-0059) ------------

// audioTarget is the engine the audio notifications go to: there is one.
var audioTarget atomic.Pointer[Engine]

//export peliAudioEvent
func peliAudioEvent(kind, shouldResume C.int) {
	e := audioTarget.Load()
	if e == nil {
		return
	}
	switch kind {
	case C.PELI_AUDIO_INTERRUPTED:
		slog.Info("iosplayer: audio interrupted")
		go e.pauseAndReport()
	case C.PELI_AUDIO_ROUTE_LOST:
		slog.Info("iosplayer: audio output lost")
		go e.pauseAndReport()
	case C.PELI_AUDIO_INTERRUPTION_ENDED:
		// Whatever the system suggests, playback stays paused: a tap resumes
		// it, with the session already active again. Starting to play on its
		// own after a phone call is a surprise that gains little.
		slog.Info("iosplayer: audio interruption ended", "shouldResume", shouldResume != 0)
	}
}

// DevAudioEvent posts the notification iOS sends for an interruption
// (1), its end (2) or the loss of the audio output (3), so the handlers can
// be driven in the simulator. Only the dev rig calls it.
func DevAudioEvent(kind int, shouldResume bool) {
	r := 0
	if shouldResume {
		r = 1
	}
	C.peli_dev_audio_event(C.int(kind), C.int(r))
}

// Suspend is what the app does before it leaves the screen. In this order,
// and returning only when all of it is done:
//
//  1. the renderer is parked (no OpenGL ES command after this point; iOS
//     kills an app that issues one in the background),
//  2. playback is paused, so the picture and sound stop where they are,
//  3. the final Report (position, paused) goes through the sink, which has
//     saved it to the store (watching.Reporter) before it returns.
//
// Only then can a push of the store, inside the background task, include it.
// It is safe to call again and from two lifecycle events (WillResignActive
// and DidEnterBackground): the second waits for the first. Resume undoes it.
func (e *Engine) Suspend() {
	e.suspendMu.Lock()
	defer e.suspendMu.Unlock()
	C.peli_host_park()
	e.held = true
	e.pauseNow()
}

// Resume restarts the renderer when the app is active again. Playback stays
// paused where it was: a tap plays.
func (e *Engine) Resume() {
	e.suspendMu.Lock()
	defer e.suspendMu.Unlock()
	if !e.held {
		return
	}
	e.held = false
	C.peli_host_unpark()
}

// pauseAndReport pauses for an interruption or a lost output, behind the
// same lock as Suspend so the two don't interleave.
func (e *Engine) pauseAndReport() {
	e.suspendMu.Lock()
	defer e.suspendMu.Unlock()
	e.pauseNow()
}

// pauseNow pauses what plays and sends its final report before it returns,
// instead of leaving that to the event loop's pause event (which would
// follow some time later). The event then finds the state already paused and
// sends nothing more. A file that is loading, paused, or gone reports
// nothing: the pause or the load's own report has it.
func (e *Engine) pauseNow() {
	e.mu.Lock()
	ses, st := e.s, e.state
	e.mu.Unlock()
	if ses == nil || st.Paused || st.Loading || !st.Active {
		return
	}
	if err := ses.m.setProperty("pause", "yes"); err != nil {
		return
	}
	pos, _ := ses.m.getString("time-pos")
	e.mu.Lock()
	if f, err := strconv.ParseFloat(pos, 64); err == nil && finite(f) {
		e.state.Position = f
	}
	e.state.Paused = true
	e.stateDirty, e.timeDirty, e.forceTime = true, true, true
	if e.reportWhy == playback.ReportPlaying {
		e.reportWhy = "" // superseded by this one
	}
	e.lastReport = time.Now()
	report := e.reportNow(playback.ReportPaused)
	e.mu.Unlock()
	e.send(report)
	ses.m.wakeup() // the loop sends the new state and time
}

// --- app lifecycle ------------------------------------------------------------

// Lifecycle is what the app does as it leaves and returns to the screen.
// Each function runs on the main thread inside UIKit's notification, so
// WillResign can finish (pause, final report) before the app leaves, and the
// others must not block for long.
type Lifecycle struct {
	WillResign, DidBackground, DidActive func()
}

var lifecycle atomic.Pointer[Lifecycle]

// OnLifecycle sets what runs for the app's lifecycle notifications. They are
// UIKit's own, not Wails' application events (see host_ios.m).
func OnLifecycle(l Lifecycle) {
	lifecycle.Store(&l)
	C.peli_lifecycle_observe()
}

//export peliLifecycle
func peliLifecycle(kind C.int) {
	l := lifecycle.Load()
	if l == nil {
		return
	}
	var f func()
	switch kind {
	case C.PELI_LIFECYCLE_WILL_RESIGN:
		f = l.WillResign
	case C.PELI_LIFECYCLE_DID_BACKGROUND:
		f = l.DidBackground
	case C.PELI_LIFECYCLE_DID_ACTIVE:
		f = l.DidActive
	}
	if f != nil {
		f()
	}
}
