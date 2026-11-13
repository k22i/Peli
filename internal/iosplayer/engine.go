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
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"
	"unsafe"

	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/store"
	"github.com/k22i/Peli/internal/streams"
)

// Hardware decoding modes. VideoToolbox's zero-copy path rejects 10-bit
// (p010) frames in mpv's iOS GLES interop, so the copy variant takes over for
// those; software is the last resort (spike: spikes/ios-libmpv).
const (
	hwVideoToolbox     = "videotoolbox"
	hwVideoToolboxCopy = "videotoolbox-copy"
	hwSoftware         = "no"
)

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

	mu         sync.Mutex
	s          *session
	state      playback.State
	stateDirty bool
	timeDirty  bool
	forceTime  bool
	lastTime   time.Time
	ended      *playback.Ended

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
	return &Engine{
		window: window, sink: sink, settings: settings,
		userAgent:   "Peli/" + version,
		http:        &http.Client{Timeout: playback.SubtitleWait},
		state:       idle(),
		reportEvery: playback.ReportEvery,
	}
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
	{"cache-buffering-state", fmtInt64},
	{"seeking", fmtFlag},
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
}

// options are set on every session before mpv_initialize.
var options = [][2]string{
	{"vo", "libmpv"}, {"ao", "audiounit"},
	{"idle", "yes"}, {"force-window", "no"}, {"keep-open", "no"},
	{"osc", "no"}, {"osd-level", "0"}, {"load-scripts", "no"}, {"ytdl", "no"},
	{"input-default-bindings", "no"}, {"input-vo-keyboard", "no"}, {"input-cursor", "no"},
	{"background-color", "#000000"},
	{"subs-match-os-language", "no"},
	// sub-auto off: the player picks tracks itself and adds addons' subtitles.
	{"sub-auto", "no"},
	// The second line is drawn by the screen (State.SecondarySubtitleText).
	{"secondary-sub-visibility", "no"},
	{"audio-format", "float"},
	// A phone has less memory than a Mac: a debrid link needs a minute of
	// read-ahead at most.
	{"demuxer-max-bytes", "64MiB"}, {"demuxer-max-back-bytes", "32MiB"},
	{"cache-secs", "90"},
}

func (e *Engine) hwdec() string {
	if e.settings != nil {
		if d, err := e.settings.DeviceSettings(); err != nil {
			slog.Warn("iosplayer: device settings unread", "error", err)
		} else if !d.HardwareDecoding {
			return hwSoftware
		}
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
	ses, err := e.open()
	if err != nil {
		return err
	}
	e.send(e.stopReport())
	ses.retried = false
	return e.loadFile(ses, source, opts, e.hwdec())
}

// loadFile starts source in ses with hardware decoding mode hw.
func (e *Engine) loadFile(ses *session, source streams.Source, opts playback.LoadOptions, hw string) error {
	var watching *playback.Watching
	if opts.Watching != nil {
		w := *opts.Watching
		watching = &w
	}
	userAgent := source.UserAgent
	if userAgent == "" {
		userAgent = e.userAgent
	}
	// Set as a list: a header's value may hold a comma.
	if err := ses.m.setStringList("http-header-fields", source.HeaderFields()); err != nil {
		return notPlaying(err)
	}
	props0 := [][2]string{{"user-agent", userAgent}, {"pause", "no"}}
	// Changing hwdec makes mpv re-initialise the decoder: only when it differs.
	if hw != ses.hw {
		props0 = append(props0, [2]string{"hwdec", hw})
	}
	for _, p := range props0 {
		if err := ses.m.setProperty(p[0], p[1]); err != nil {
			return notPlaying(err)
		}
	}
	props := playback.TrackProps(opts, osCaptions(), playback.IOSFonts)
	props = append(props, [2]string{"speed", "1"}, [2]string{"sub-delay", "0"})
	for _, p := range props {
		if err := ses.m.setProperty(p[0], p[1]); err != nil {
			return notPlaying(err)
		}
	}
	ses.hw, ses.hwSwitched, ses.firstFrame = hw, false, false
	ses.source, ses.opts, ses.loadedAt = source, opts, time.Now()
	e.update(func(st *playback.State) {
		st.Loading, st.Buffering, st.BufferPercent, st.Seeking = true, false, 0, false
		st.Time = playback.Time{Position: opts.Start}
		st.Tracks, st.Chapters = []playback.Track{}, []playback.Chapter{}
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

// open returns the open session, or opens one. ops must be held.
func (e *Engine) open() (*session, error) {
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
	ses = &session{m: m, done: make(chan struct{}), hw: e.hwdec()}
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
	if err := m.setOptionString("hwdec", e.hwdec()); err != nil {
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
	go e.loop(ses)
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
	return ses, nil
}

// Stop ends the session.
func (e *Engine) Stop() error {
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
	e.state = idle()
	e.mu.Unlock()
	e.flush(nil)
	return nil
}

// closeSession follows the binding rules from M0: stop the event loop, free
// the render context (detach), then destroy the handle.
func (e *Engine) closeSession(ses *session) {
	ses.closing.Store(true)
	ses.m.wakeup()
	<-ses.done
	C.peli_host_detach()
	C.peli_host_awake(0)
	ses.m.destroy()
	if ses.subDir != "" {
		os.RemoveAll(ses.subDir)
	}
}

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

func (e *Engine) SetSubtitleTrack(id int) error {
	switch {
	case id < 0:
		return playback.ErrInvalid
	case id == 0:
		return e.set("sid", "no")
	}
	if e.Snapshot().SecondaryIs(id) {
		if err := e.set("secondary-sid", "no"); err != nil {
			return err
		}
	}
	return e.set("sid", strconv.Itoa(id))
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
	return e.set("sub-scale", playback.Seconds(scale))
}

func (e *Engine) SetSubtitleStyle(style playback.SubtitleStyle) error {
	if !style.Valid() {
		return playback.ErrInvalid
	}
	for _, p := range playback.StyleProps(style, playback.IOSFonts) {
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
func (e *Engine) AddSubtitle(ctx context.Context, sub playback.Subtitle) (int, error) {
	u, err := url.Parse(sub.URL)
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
	e.ops.Lock()
	defer e.ops.Unlock()
	ses := e.current()
	if ses == nil {
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
	if sub.Secondary {
		if err := ses.m.setProperty("secondary-sid", strconv.Itoa(id)); err != nil {
			return 0, fmt.Errorf("%w: %w", playback.ErrSubtitles, err)
		}
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
		// The zero-copy VideoToolbox interop refuses 10-bit frames.
		if ses.hw == hwVideoToolbox && !ses.hwSwitched && strings.Contains(text, "Format unsupported") {
			e.switchHW(ses, hwVideoToolboxCopy, "format unsupported")
		}
		if ev.Level == "error" || ev.Level == "fatal" {
			ses.lastErr = text
			slog.Warn("mpv: "+text, "module", ev.Prefix)
		} else {
			slog.Debug("mpv: "+text, "module", ev.Prefix, "level", ev.Level)
		}
	}
}

// switchHW changes the decoding mode of the file playing. mpv re-initialises
// the decoder and seeks back to where it was.
func (e *Engine) switchHW(ses *session, mode, why string) {
	if ses.hwSwitched {
		return
	}
	ses.hwSwitched = true
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
	case "volume":
		st.Volume = playback.Number(v)
	case "mute":
		st.Muted, _ = v.(bool)
	case "speed":
		st.Speed = playback.Number(v)
	case "track-list":
		st.Tracks = playback.TracksFrom(v)
	case "chapter-list":
		st.Chapters = playback.ChaptersFrom(v)
	case "hwdec-current":
		st.HWDec, _ = v.(string)
		if st.HWDec == hwSoftware {
			st.HWDec = ""
		}
	case "sub-delay":
		st.SubtitleDelay = math.Round(playback.Number(v)*1000) / 1000
	case "sub-scale":
		st.SubtitleSize = playback.SubtitleSizeName(playback.Number(v))
	case "sub-text":
		st.SubtitleText, _ = v.(string)
	case "secondary-sub-text":
		st.SecondarySubtitleText, _ = v.(string)
	}
	e.stateDirty = true
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
