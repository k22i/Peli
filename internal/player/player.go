// Package player plays video with libmpv, linked in-process (ADR-0001), under
// the webview in the app window (ADR-0002). The frontend loads a resolved
// stream (#53) and drives playback through the Service; mpv's state comes
// back as Wails events. See ADR-0039.
//
// One session is one mpv handle and one video surface: Load opens it, Stop
// and app shutdown close it. Closing follows the binding rules from M0: stop
// the event loop with mpv_wakeup, free the render context, then
// mpv_terminate_destroy.
//
// Stream URLs carry debrid keys, so no URL is logged or put in an error, and
// mpv's log messages have theirs removed.
package player

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log/slog"
	"math"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"

	"github.com/k22i/Sinag/internal/store"
	"github.com/k22i/Sinag/internal/streams"
)

// Events the player sends the frontend. Events sent before the page listens
// are queued and may arrive seconds late (M0, #3), so the frontend reads
// Snapshot when it mounts and applies events after it.
const (
	// EventState carries the whole State whenever anything but the time
	// changes.
	EventState = "player:state"
	// EventTime carries the position, duration and buffer, at most every
	// TimeEvery while playing, and at once after a seek.
	EventTime = "player:time"
	// EventEnded says the file ended by itself: played to the end, or failed.
	// Stop and loading another file don't send it.
	EventEnded = "player:ended"
)

func init() {
	application.RegisterEvent[State](EventState)
	application.RegisterEvent[Time](EventTime)
	application.RegisterEvent[Ended](EventEnded)
}

// TimeEvery throttles EventTime. mpv changes time-pos every frame (30–60 a
// second), and a React re-render per frame cost ~10 % CPU in WebKit (M0, #4);
// a seek bar needs about 4 a second.
const TimeEvery = 250 * time.Millisecond

var (
	// ErrInvalid means an argument was out of range, or the stream had no URL.
	ErrInvalid = errors.New("player: invalid argument")
	// ErrUnavailable means playback couldn't start: libmpv or the video host
	// failed to come up.
	ErrUnavailable = errors.New("player: unavailable")
	// ErrNotPlaying means there's no session to control: nothing was loaded,
	// or it was stopped.
	ErrNotPlaying = errors.New("player: nothing is playing")
)

// Error codes the frontend reads (MarshalError).
const (
	CodeInvalid     = "invalid"
	CodeUnavailable = "unavailable"
	CodeNotPlaying  = "not_playing"
)

// Codes in Ended when a file failed.
const (
	// EndExpired means the server refused the link (401, 403, 404, 410):
	// debrid links expire, and the addon gives a new one.
	EndExpired = "expired"
	// EndUnsupported means mpv found nothing it can play in the file.
	EndUnsupported = "unsupported"
	// EndFailed is any other failure: the network, a broken file.
	EndFailed = "failed"
)

// State is the player's state, as Snapshot returns it and EventState
// carries it. Times are in seconds.
type State struct {
	// Active is true from Load until Stop.
	Active bool `json:"active"`
	// Loading is true from Load until the first frame (and after a file
	// ended, false).
	Loading bool `json:"loading"`
	Paused  bool `json:"paused"`
	// Buffering is true while playback waits for the network.
	Buffering bool `json:"buffering"`
	// BufferPercent is how full the cache is while Buffering, 0–100.
	BufferPercent int  `json:"bufferPercent"`
	Seeking       bool `json:"seeking"`
	Time
	// Volume is 0–100.
	Volume     float64 `json:"volume"`
	Muted      bool    `json:"muted"`
	Speed      float64 `json:"speed"`
	Fullscreen bool    `json:"fullscreen"`
	// Mini is true while the window is the mini player (#70): small, in a
	// corner of the screen, above other windows.
	Mini   bool    `json:"mini"`
	Tracks []Track `json:"tracks"`
	// Chapters are the file's chapters, in order (#69): their names say
	// where intros and credits are in some files.
	Chapters []Chapter `json:"chapters"`
	// SubtitleDelay is how much later than the file says subtitles show, in
	// seconds; negative is earlier.
	SubtitleDelay float64 `json:"subtitleDelay"`
	// SubtitleSize is "small", "medium" or "large", or "" for a scale mpv
	// was given some other way.
	SubtitleSize string `json:"subtitleSize"`
	// SubtitleText is the subtitle line showing now, "" between lines: the
	// timing tool shows it so the user can match it to the speech.
	SubtitleText string `json:"subtitleText"`
	// HWDec is the hardware decoder in use, "" for software.
	HWDec string `json:"hwdec"`
	// HDR is true while an HDR video goes to the display as HDR, rather
	// than tone-mapped to SDR (#66).
	HDR bool `json:"hdr"`
	// AutoCrop is the crop auto-crop found for the file, in percent; nil
	// until it finds one, or when it's off.
	AutoCrop *store.Crop `json:"autoCrop,omitempty"`
}

// Time is where playback is, in seconds.
type Time struct {
	Position float64 `json:"position"`
	Duration float64 `json:"duration"`
	// Buffered is how far ahead of Position the cache reaches.
	Buffered float64 `json:"buffered"`
}

// Track is one of the file's video, audio or subtitle tracks.
type Track struct {
	ID       int    `json:"id"`
	Type     string `json:"type"` // "video", "audio" or "sub"
	Title    string `json:"title"`
	Lang     string `json:"lang"`
	Codec    string `json:"codec"`
	Default  bool   `json:"default"`
	Selected bool   `json:"selected"`
	External bool   `json:"external"`
	// Forced subtitles only translate signs and foreign dialogue;
	// HearingImpaired ones (SDH) also describe sounds.
	Forced          bool `json:"forced"`
	HearingImpaired bool `json:"hearingImpaired"`
	// Channels is an audio track's channel count.
	Channels int `json:"channels,omitempty"`
	// Width and Height are a video track's size.
	Width  int `json:"width,omitempty"`
	Height int `json:"height,omitempty"`
}

// Chapter is one of the file's chapters: its name and where it starts, in
// seconds.
type Chapter struct {
	Title string  `json:"title"`
	Time  float64 `json:"time"`
}

// Ended says why a file ended by itself.
type Ended struct {
	Reason string `json:"reason"` // "eof" or "error"
	// Code is EndExpired, EndUnsupported or EndFailed when Reason is "error".
	Code string `json:"code,omitempty"`
	// Message is mpv's error, for logs and bug reports.
	Message string `json:"message,omitempty"`
}

// LoadOptions are the optional parts of Load.
type LoadOptions struct {
	// Start is where to start, in seconds.
	Start float64 `json:"start"`
	// AudioLanguages and SubtitleLanguage pick the tracks, as ISO 639 codes
	// ("en", "jpn"). The first audio language the file has is played (#98);
	// none, or "" for the subtitles, is the file's own default (#62).
	AudioLanguages   []string `json:"audioLanguages"`
	SubtitleLanguage string   `json:"subtitleLanguage"`
	// Captions is "on", "off", or "system" (or "") for the OS's captions
	// preference. On shows full subtitles: in SubtitleLanguage if the file
	// has them, or else its default or first. Off still shows forced ones
	// (signs, foreign dialogue) in the audio's language.
	Captions string `json:"captions"`
	// SubtitleSize is "small", "medium" or "large"; "" keeps the current.
	// A SubtitleStyle's size wins over it.
	SubtitleSize string `json:"subtitleSize"`
	// SubtitleStyle is how text subtitles look; nil keeps mpv's.
	SubtitleStyle *SubtitleStyle `json:"subtitleStyle,omitempty"`
	// Picture adjusts the video; nil is the title's own (TitleAdjustments)
	// or the profile's, read from the store for Watching's profile.
	Picture *store.Picture `json:"picture,omitempty"`
	// Framing frames the picture; nil is the title's own or the profile's,
	// like Picture.
	Framing *store.Framing `json:"framing,omitempty"`
	// Watching names what the file is, so how far it plays is reported
	// (#64); nil for a file nobody keeps progress of.
	Watching *Watching `json:"watching,omitempty"`
}

// Watching is the film or episode a file plays, as the profile's progress
// and watched items name it.
type Watching struct {
	ProfileID   uint64 `json:"profileId"`
	ContentID   string `json:"contentId"`
	ContentType string `json:"contentType"`
	VideoID     string `json:"videoId"`
	Season      *int   `json:"season,omitempty"`
	Episode     *int   `json:"episode,omitempty"`
	// Title names the watched item: the episode's name, or the title's.
	Title string `json:"title,omitempty"`
	// What SIMKL and AniList need to name it (#73, #105): the film's or
	// series' own name and year, and its ids by catalog ("imdb", "tmdb",
	// "tvdb", "kitsu", "mal", "anilist", "anidb").
	Name string            `json:"name,omitempty"`
	Year int               `json:"year,omitempty"`
	IDs  map[string]string `json:"ids,omitempty"`
}

// Report says how far a Watching file got, and why it's said now. Times are
// in seconds.
type Report struct {
	Watching Watching
	Position float64
	Duration float64
	Why      string
}

// Why a Report is sent.
const (
	// ReportPlaying comes every ReportEvery while the file plays.
	ReportPlaying = "playing"
	// ReportPaused, ReportSeeked, ReportEnded and ReportStopped come when
	// the file pauses, lands after a seek, ends by itself (played to the
	// end, or failed), or is stopped or replaced (leaving the screen,
	// another Load, the app quitting).
	ReportPaused  = "paused"
	ReportSeeked  = "seeked"
	ReportEnded   = "ended"
	ReportStopped = "stopped"
	// ReportStarted comes at a file's first frame, and ReportResumed when
	// it plays again after a pause: what a scrobble's start is (#73).
	ReportStarted = "started"
	ReportResumed = "resumed"
)

// ReportEvery is how often a file that plays is reported. The store keeps
// each report; the push loop sends progress at most every 30 s.
const ReportEvery = 10 * time.Second

// subtitleScales are mpv's sub-scale for each SubtitleSize.
var subtitleScales = map[string]float64{"small": 0.75, "medium": 1, "large": 1.35}

// MaxSubtitleDelay bounds SetSubtitleDelay, in seconds either way.
const MaxSubtitleDelay = 600

var languageCode = regexp.MustCompile(`^([a-z]{2,3})?$`)

// systemCaptions reports whether the OS asks for captions; a variable so
// tests can set it.
var systemCaptions = osCaptions

func (o LoadOptions) valid() bool {
	_, sized := subtitleScales[o.SubtitleSize]
	return o.Start >= 0 && !math.IsNaN(o.Start) &&
		// Codes only: mpv's alang and slang are lists, split on commas.
		languageCode.MatchString(o.SubtitleLanguage) && audioLanguagesValid(o.AudioLanguages) &&
		(o.Captions == "" || o.Captions == "system" || o.Captions == "on" || o.Captions == "off") &&
		(o.SubtitleSize == "" || sized) && (o.SubtitleStyle == nil || o.SubtitleStyle.valid()) &&
		(o.Picture == nil || o.Picture.Valid()) && (o.Framing == nil || o.Framing.Valid()) &&
		(o.Watching == nil || (o.Watching.ContentID != "" && o.Watching.ContentType != ""))
}

// audioLanguagesValid reports whether every one of codes is a code, and none
// is empty: an empty entry would end mpv's list early.
func audioLanguagesValid(codes []string) bool {
	for _, code := range codes {
		if code == "" || !languageCode.MatchString(code) {
			return false
		}
	}
	return true
}

// tracks are the properties that pick a new file's tracks from o, found by
// trying mpv 0.41 on files with forced and default-flagged subtitles.
func (o LoadOptions) tracks() [][2]string {
	captions := o.Captions == "on" || (o.Captions != "off" && systemCaptions())
	props := [][2]string{
		{"aid", "auto"}, {"sid", "auto"},
		{"alang", strings.Join(o.AudioLanguages, ",")},
		// Off: no language and no fallback leaves forced subtitles only.
		{"slang", ""}, {"subs-fallback", "no"}, {"subs-fallback-forced", "yes"},
	}
	if captions {
		// On: the language's full subtitles over its forced ones, and
		// any subtitles over none.
		props[3][1] = o.SubtitleLanguage
		props[4][1], props[5][1] = "yes", "no"
	}
	if o.SubtitleStyle != nil {
		props = append(props, o.SubtitleStyle.props()...)
	} else if scale, ok := subtitleScales[o.SubtitleSize]; ok {
		props = append(props, [2]string{"sub-scale", seconds(scale)})
	}
	return props
}

// observed are the properties a session observes, with the format libmpv
// sends them in. The observe id is the index + 1.
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
	{"vo-configured", fmtFlag},
	{"sub-delay", fmtDouble},
	{"sub-scale", fmtDouble},
	{"video-params/gamma", fmtString},
	{"sub-text", fmtString},
	// The video's size, for a crop in percent (framing.go).
	{"video-params/w", fmtInt64},
	{"video-params/h", fmtInt64},
}

// options are set on every session before mpv_initialize; the host adds its
// own (vo, wid).
var options = [][2]string{
	// libmpv already reads no config files and writes nothing to the
	// terminal. With vo=libmpv, force-window would start the VO before the
	// render context exists, and mpv would fall back to one with its own
	// window.
	{"idle", "yes"}, {"force-window", "no"}, {"keep-open", "no"},
	// No mpv UI or scripts: React is the UI, and youtube-dl must not run
	// for an HTTP link.
	{"osc", "no"}, {"osd-level", "0"}, {"load-scripts", "no"}, {"ytdl", "no"},
	// Pointer and keyboard go to the webview above (M0, #2).
	{"input-default-bindings", "no"}, {"input-vo-keyboard", "no"}, {"input-cursor", "no"},
	{"input-cursor-passthrough", "yes"}, {"cursor-autohide", "no"},
	{"background-color", "#000000"},
	// A language left "" means the file's default, not the OS's (#62).
	{"subs-match-os-language", "no"},
}

// Settings is where a session reads whether to decode on the GPU: the
// store's device settings.
type Settings interface {
	DeviceSettings() (store.DeviceSettings, error)
}

// Service is the Wails service the frontend calls to play a stream.
type Service struct {
	userAgent string
	// settings are nil until UseSettings: hardware decoding stays on.
	settings Settings
	// http downloads addon subtitles.
	http *http.Client
	// newHost makes the video host for a session; nil until UseWindow.
	newHost func() (host, error)
	window  *application.WebviewWindow
	// windowed gets a value each time the window leaves fullscreen.
	windowed chan struct{}
	// windowOps serialises fullscreen and mini player changes.
	windowOps sync.Mutex
	emit      func(name string, data any)
	// report gets how far a Watching file got (#64); nil until ReportTo.
	report      func(Report)
	reportEvery time.Duration
	// media are the OS's media controls (#67); nil until UseMediaControls.
	media mediaControls
	// gate is asked before the user's pauses, seeks and speed changes: a
	// watch party (ADR-0051). Nil until GateWith.
	gate atomic.Pointer[Gate]

	// ops serialises opening and closing sessions.
	ops sync.Mutex

	mu    sync.Mutex
	s     *session
	state State
	// What the event loop has yet to send.
	stateDirty, timeDirty, forceTime bool
	ended                            *Ended
	lastTime                         time.Time
	// What the file playing is, why it's due a report and when it last had
	// one.
	watching   *Watching
	reportWhy  string
	lastReport time.Time
	// What the media controls name, whether they're due the state, and how
	// many times the position jumped.
	nowPlaying NowPlaying
	mediaDirty bool
	seeks      int
	// How the file playing is framed, its video's size (0 until known),
	// which Load it is (file counts them), and the auto-crop looking at it.
	framing        store.Framing
	videoW, videoH int
	file           uint64
	autoCrop       context.CancelFunc
	autoCropFile   uint64
}

// session is one mpv handle and its video host.
type session struct {
	m       *mpv
	host    host
	done    chan struct{}
	closing atomic.Bool

	// Only the event loop uses these.
	loaded  bool   // a file is loaded (file-loaded until end-file)
	started bool   // the file showed its first frame (playback-restart)
	playing bool   // what host.playing was last told
	lastErr string // the file's last error-level log message
	httpErr string // the file's last refused HTTP request, from FFmpeg

	// subDir holds the addon subtitles AddSubtitle added (#63); ops guards
	// it.
	subDir string

	// hdr is whether the host is showing HDR; only the event loop uses it.
	hdr bool
}

// NewService returns a Service that sends version in its User-Agent when a
// stream doesn't name one. It can't show video until UseWindow.
func NewService(version string) *Service {
	return &Service{
		userAgent:   fmt.Sprintf("Sinag/%s (+https://github.com/k22i/Sinag)", version),
		http:        &http.Client{},
		windowed:    make(chan struct{}, 1),
		emit:        func(string, any) {},
		state:       idle(false),
		reportEvery: ReportEvery,
	}
}

func idle(fullscreen bool) State {
	return State{
		Volume: 100, Speed: 1, Fullscreen: fullscreen, Tracks: []Track{}, Chapters: []Chapter{},
		SubtitleSize: "medium",
	}
}

// UseWindow puts the service's video in window, and follows its fullscreen
// state. It isn't a method, so Wails doesn't bind it.
func UseWindow(s *Service, window *application.WebviewWindow) {
	s.mu.Lock()
	s.window = window
	s.newHost = func() (host, error) { return newHost(window) }
	s.mu.Unlock()
	fullscreen := func(on bool) func(*application.WindowEvent) {
		return func(*application.WindowEvent) {
			s.update(func(st *State) { st.Fullscreen = on })
			if !on {
				select {
				case s.windowed <- struct{}{}:
				default:
				}
			}
		}
	}
	window.OnWindowEvent(events.Common.WindowFullscreen, fullscreen(true))
	window.OnWindowEvent(events.Common.WindowUnFullscreen, fullscreen(false))
}

// UseSettings has each session read whether to decode on the GPU from
// settings, when it opens. It isn't a method, so Wails doesn't bind it.
func UseSettings(s *Service, settings Settings) {
	s.mu.Lock()
	s.settings = settings
	s.mu.Unlock()
}

// hwdec is mpv's hwdec for a new session: the OS's own decoder API first,
// then any other mpv deems safe, or none when the user turned it off. mpv
// decodes in software whatever the GPU can't, and falls back to software
// when a hardware decoder fails on a file.
func (s *Service) hwdec() string {
	s.mu.Lock()
	settings := s.settings
	s.mu.Unlock()
	on := true
	if settings != nil {
		if d, err := settings.DeviceSettings(); err != nil {
			slog.Warn("player: device settings unread", "error", err)
		} else {
			on = d.HardwareDecoding
		}
	}
	if !on {
		return "no"
	}
	return hwdecAPIs
}

// ReportTo sends how far each Watching file plays to report: every
// ReportEvery while playing, and when it pauses, seeks, ends or is stopped.
// It's called on the player's own goroutine, or in Stop and Load, so it
// shouldn't wait on the network. It isn't a method, so Wails doesn't bind
// it.
func ReportTo(s *Service, report func(Report)) {
	s.mu.Lock()
	s.report = report
	s.mu.Unlock()
}

// ServiceStartup has the service send its events to the frontend.
func (s *Service) ServiceStartup(context.Context, application.ServiceOptions) error {
	if app := application.Get(); app != nil {
		s.emit = func(name string, data any) { app.Event.Emit(name, data) }
	}
	return nil
}

// ServiceShutdown closes the session, if one is open.
func (s *Service) ServiceShutdown() error {
	return s.Stop()
}

// Load plays source, opening a session if none is open, or replacing what
// the open one plays. It returns once mpv has the file; EventState says when
// it plays, EventEnded if it fails.
func (s *Service) Load(source streams.Source, opts LoadOptions) error {
	if source.URL == "" || !opts.valid() {
		return ErrInvalid
	}
	s.ops.Lock()
	defer s.ops.Unlock()
	ses, err := s.open()
	if err != nil {
		return err
	}
	// The file this one replaces got as far as it got.
	s.sendReport(s.stopReport())
	var watching *Watching
	if opts.Watching != nil {
		w := *opts.Watching
		watching = &w
	}
	userAgent := source.UserAgent
	if userAgent == "" {
		userAgent = s.userAgent
	}
	// Set as a list: a header's value may hold a comma, which mpv's string
	// form splits on.
	if err := ses.m.setStringList("http-header-fields", source.HeaderFields()); err != nil {
		return notPlaying(err)
	}
	if err := ses.m.setProperty("user-agent", userAgent); err != nil {
		return notPlaying(err)
	}
	if err := ses.m.setProperty("pause", "no"); err != nil {
		return notPlaying(err)
	}
	// The session keeps the last file's picture and framing: each file
	// sets its own. The crop waits for the video's size.
	framing := s.framingFor(opts)
	s.stopAutoCrop()
	s.mu.Lock()
	s.framing, s.videoW, s.videoH = framing, 0, 0
	s.file++
	s.mu.Unlock()
	props := append(opts.tracks(), pictureProps(s.pictureFor(opts))...)
	props = append(props, framingProps(framing)...)
	props = append(props, [2]string{"video-crop", ""})
	for _, p := range props {
		if err := ses.m.setProperty(p[0], p[1]); err != nil {
			return notPlaying(err)
		}
	}
	// Before loadfile, so the new file's first frame can't come first.
	s.update(func(st *State) {
		st.Loading, st.Buffering, st.BufferPercent, st.Seeking = true, false, 0, false
		st.Time = Time{Position: opts.Start}
		st.Tracks, st.Chapters, st.AutoCrop = []Track{}, []Chapter{}, nil
		s.watching, s.reportWhy, s.lastReport = watching, "", time.Now()
	})
	args := []string{"loadfile", source.URL, "replace"}
	if opts.Start > 0 {
		args = append(args, "-1", "start="+seconds(opts.Start))
	}
	if err := ses.m.command(args...); err != nil {
		s.update(func(st *State) { st.Loading = false })
		return notPlaying(err)
	}
	return nil
}

// open returns the open session, or opens one. ops must be held.
func (s *Service) open() (*session, error) {
	s.mu.Lock()
	ses, newHost := s.s, s.newHost
	s.mu.Unlock()
	if ses != nil {
		return ses, nil
	}
	hwdec := s.hwdec()
	if newHost == nil {
		return nil, fmt.Errorf("%w: no window for the video", ErrUnavailable)
	}
	h, err := newHost()
	if err == nil {
		err = h.prepare()
	}
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	m, err := mpvCreate()
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	ses = &session{m: m, host: h, done: make(chan struct{})}
	fail := func(err error) (*session, error) {
		close(ses.done)
		m.destroy()
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	for _, o := range options {
		// An option a build lacks isn't worth failing playback over.
		if err := m.setOptionString(o[0], o[1]); err != nil {
			slog.Warn("player: option not set", "error", err)
		}
	}
	if err := m.setOptionString("hwdec", hwdec); err != nil {
		slog.Warn("player: option not set", "error", err)
	}
	if err := h.configure(m); err != nil {
		return fail(err)
	}
	// $SINAG_MPV_OPTIONS ("gpu-sw hwdec=no") overrides any of these, for
	// debugging playback, and for CI and containers without a GPU.
	for _, o := range strings.Fields(os.Getenv("SINAG_MPV_OPTIONS")) {
		name, value, ok := strings.Cut(o, "=")
		if !ok {
			value = "yes"
		}
		if err := m.setOptionString(name, value); err != nil {
			slog.Warn("player: option not set", "error", err)
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
	// "v": at "warn", libmpv drops FFmpeg's "HTTP error 403", which is how
	// an expired link shows. These come per file, not per frame.
	if err := m.requestLogMessages("v"); err != nil {
		return fail(err)
	}
	go s.loop(ses)
	// The render context must exist before the first loadfile.
	if err := h.attach(m); err != nil {
		s.closeSession(ses)
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	s.mu.Lock()
	s.s = ses
	fullscreen := s.state.Fullscreen
	s.state = idle(fullscreen)
	s.state.Active = true
	s.stateDirty = true
	s.mu.Unlock()
	s.fillScreen()
	return ses, nil
}

// fillScreen makes the window as big as its screen allows for playback,
// short of fullscreen: what a double click on the title bar does. restore
// puts it back.
func (s *Service) fillScreen() {
	s.windowOps.Lock()
	defer s.windowOps.Unlock()
	s.mu.Lock()
	window := s.window
	s.mu.Unlock()
	if window != nil {
		fillScreen(window)
	}
}

// restoreWindow leaves the mini player and puts the window back at its
// size before playback, in one move. Only Stop calls it, which sets the
// state's Mini off itself.
func (s *Service) restoreWindow() {
	s.windowOps.Lock()
	defer s.windowOps.Unlock()
	s.mu.Lock()
	window := s.window
	s.mu.Unlock()
	if window != nil {
		restoreWindow(window)
	}
}

// Stop closes the session: playback stops, the video surface goes and mpv is
// destroyed. It's fine to call when nothing is playing.
func (s *Service) Stop() error {
	s.ops.Lock()
	defer s.ops.Unlock()
	s.mu.Lock()
	ses := s.s
	s.mu.Unlock()
	if ses == nil {
		return nil
	}
	// Before the stop, so the position is the one the user left at.
	s.sendReport(s.stopReport())
	_ = ses.m.command("stop")
	s.closeSession(ses)
	// The app window again, at its size before playback, whatever the
	// screen does next.
	s.restoreWindow()
	s.mu.Lock()
	s.s = nil
	s.state = idle(s.state.Fullscreen)
	s.stateDirty, s.timeDirty, s.forceTime, s.ended = false, false, false, nil
	s.watching, s.reportWhy = nil, ""
	s.nowPlaying, s.mediaDirty, s.seeks = NowPlaying{}, false, 0
	state, media := s.copyState(), s.media
	s.mu.Unlock()
	s.emit(EventState, state)
	if media != nil {
		media.show(nil)
	}
	return nil
}

// closeSession stops the event loop, then the host, then mpv, in the order
// libmpv needs.
func (s *Service) closeSession(ses *session) {
	s.stopAutoCrop()
	ses.closing.Store(true)
	ses.m.wakeup()
	<-ses.done
	if ses.playing {
		ses.host.playing(false)
	}
	ses.host.detach()
	ses.m.destroy()
	if ses.subDir != "" {
		_ = os.RemoveAll(ses.subDir)
	}
}

// Gate is asked before each of the user's pauses, seeks and speed changes
// reaches mpv, and may refuse it: a watch party (ADR-0051) publishes them
// to the other members, or refuses them while only the host controls
// playback. A refused change does nothing, and isn't an error.
type Gate interface {
	UserPause(paused bool) bool
	// UserSeek returns where to go, or false to stay.
	UserSeek(position float64) (float64, bool)
	UserSpeed(speed float64) bool
	// UserScrub is told while the seek bar is dragged.
	UserScrub()
}

// GateWith has s ask g before the user's changes. It isn't a method, so
// Wails doesn't bind it.
func GateWith(s *Service, g Gate) { s.gate.Store(&g) }

func (s *Service) gated() Gate {
	if g := s.gate.Load(); g != nil {
		return *g
	}
	return nil
}

// Direct is the player without its gate: what a watch party uses to keep
// playback in step, which mustn't come back to it as the user's.
type Direct struct{ s *Service }

// DirectOf returns s without its gate. It isn't a method, so Wails doesn't
// bind it.
func DirectOf(s *Service) Direct { return Direct{s} }

func (d Direct) Snapshot() State              { return d.s.Snapshot() }
func (d Direct) SetPaused(paused bool) error  { return d.s.set("pause", flag(paused)) }
func (d Direct) Seek(position float64) error  { return d.s.seek(position) }
func (d Direct) SetSpeed(speed float64) error { return d.s.setSpeed(speed) }

// SetPaused pauses or resumes playback.
func (s *Service) SetPaused(paused bool) error {
	if g := s.gated(); g != nil && !g.UserPause(paused) {
		return nil
	}
	return s.set("pause", flag(paused))
}

// Seek goes to position, in seconds from the start.
func (s *Service) Seek(position float64) error {
	if position < 0 || math.IsNaN(position) || math.IsInf(position, 0) {
		return ErrInvalid
	}
	if g := s.gated(); g != nil {
		to, ok := g.UserSeek(position)
		if !ok {
			return nil
		}
		position = to
	}
	return s.seek(position)
}

func (s *Service) seek(position float64) error {
	if position < 0 || math.IsNaN(position) || math.IsInf(position, 0) {
		return ErrInvalid
	}
	return s.command("seek", seconds(position), "absolute")
}

// Scrub goes to the keyframe nearest position, in seconds from the start:
// quick enough to follow a seek bar being dragged, where Seek would decode
// from the keyframe to the exact frame every time. A Seek when the drag
// ends lands exactly.
func (s *Service) Scrub(position float64) error {
	if position < 0 || math.IsNaN(position) || math.IsInf(position, 0) {
		return ErrInvalid
	}
	if g := s.gated(); g != nil {
		g.UserScrub()
	}
	return s.command("seek", seconds(position), "absolute+keyframes")
}

// SeekBy moves by delta seconds, back when it's negative. With a gate it
// is a Seek to where that lands.
func (s *Service) SeekBy(delta float64) error {
	if math.IsNaN(delta) || math.IsInf(delta, 0) {
		return ErrInvalid
	}
	if s.gated() != nil {
		return s.Seek(math.Max(0, s.Snapshot().Position+delta))
	}
	return s.command("seek", seconds(delta), "relative")
}

// SetVolume sets the volume, 0–100.
func (s *Service) SetVolume(volume float64) error {
	if volume < 0 || volume > 100 || math.IsNaN(volume) {
		return ErrInvalid
	}
	return s.set("volume", seconds(volume))
}

// SetMuted mutes or unmutes.
func (s *Service) SetMuted(muted bool) error {
	return s.set("mute", flag(muted))
}

// SetSpeed sets the playback speed, 0.25–4.
func (s *Service) SetSpeed(speed float64) error {
	if speed < 0.25 || speed > 4 || math.IsNaN(speed) {
		return ErrInvalid
	}
	if g := s.gated(); g != nil && !g.UserSpeed(speed) {
		return nil
	}
	return s.setSpeed(speed)
}

func (s *Service) setSpeed(speed float64) error {
	if speed < 0.25 || speed > 4 || math.IsNaN(speed) {
		return ErrInvalid
	}
	return s.set("speed", seconds(speed))
}

// SetAudioTrack plays the audio track with id, from State.Tracks.
func (s *Service) SetAudioTrack(id int) error {
	if id < 1 {
		return ErrInvalid
	}
	return s.set("aid", strconv.Itoa(id))
}

// SetSubtitleTrack shows the subtitle track with id, from State.Tracks, or
// none for 0.
func (s *Service) SetSubtitleTrack(id int) error {
	switch {
	case id < 0:
		return ErrInvalid
	case id == 0:
		return s.set("sid", "no")
	}
	return s.set("sid", strconv.Itoa(id))
}

// SetSubtitleDelay shows subtitles delay seconds later than the file says,
// or earlier when it's negative, up to MaxSubtitleDelay either way.
func (s *Service) SetSubtitleDelay(delay float64) error {
	if math.IsNaN(delay) || math.Abs(delay) > MaxSubtitleDelay {
		return ErrInvalid
	}
	return s.set("sub-delay", seconds(delay))
}

// SetSubtitleSize sizes subtitles: "small", "medium" or "large".
func (s *Service) SetSubtitleSize(size string) error {
	scale, ok := subtitleScales[size]
	if !ok {
		return ErrInvalid
	}
	return s.set("sub-scale", seconds(scale))
}

// SetFullscreen puts the window in or out of fullscreen. The mini player
// becomes the app window first.
func (s *Service) SetFullscreen(on bool) error {
	s.windowOps.Lock()
	defer s.windowOps.Unlock()
	s.mu.Lock()
	window := s.window
	s.mu.Unlock()
	if window == nil {
		return fmt.Errorf("%w: no window", ErrUnavailable)
	}
	if on {
		if err := s.setMini(window, false); err != nil {
			return err
		}
		window.Fullscreen()
	} else {
		window.UnFullscreen()
	}
	return nil
}

// leaveFullscreenFor is how long SetMini waits for the window to leave
// fullscreen: macOS animates it.
const leaveFullscreenFor = 3 * time.Second

// SetMini makes the window the mini player (#70), or the app window again.
// The mini player is the same window, small, in the bottom right corner of
// its screen (or where it was last left), above other windows, in the
// video's shape; leaving puts it back where it was. A fullscreen window
// leaves fullscreen first. It needs a session; Stop leaves it.
func (s *Service) SetMini(on bool) error {
	s.windowOps.Lock()
	defer s.windowOps.Unlock()
	s.mu.Lock()
	window, ses := s.window, s.s
	s.mu.Unlock()
	if window == nil {
		return fmt.Errorf("%w: no window", ErrUnavailable)
	}
	if on && ses == nil {
		return ErrNotPlaying
	}
	if on && window.IsFullscreen() {
		select {
		case <-s.windowed:
		default:
		}
		window.UnFullscreen()
		select {
		case <-s.windowed:
		case <-time.After(leaveFullscreenFor):
		}
	}
	return s.setMini(window, on)
}

// setMini changes the window, and the state, if Mini isn't on already.
func (s *Service) setMini(window *application.WebviewWindow, on bool) error {
	s.mu.Lock()
	mini, ses := s.state.Mini, s.s
	s.mu.Unlock()
	if mini == on {
		return nil
	}
	aspect := 0.0
	if on && ses != nil {
		// The video's shape, as shown: "" before the first frame.
		if a, err := ses.m.getString("video-out-params/aspect"); err == nil {
			aspect, _ = strconv.ParseFloat(a, 64)
		}
	}
	if err := setMini(window, on, aspect); err != nil {
		return fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	s.update(func(st *State) { st.Mini = on })
	return nil
}

// Snapshot returns the current state.
func (s *Service) Snapshot() State {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.copyState()
}

func (s *Service) copyState() State {
	st := s.state
	st.Tracks = append([]Track{}, st.Tracks...)
	st.Chapters = append([]Chapter{}, st.Chapters...)
	return st
}

func (s *Service) set(name, value string) error {
	ses := s.current()
	if ses == nil {
		return ErrNotPlaying
	}
	return notPlaying(ses.m.setProperty(name, value))
}

func (s *Service) command(args ...string) error {
	ses := s.current()
	if ses == nil {
		return ErrNotPlaying
	}
	return notPlaying(ses.m.command(args...))
}

func (s *Service) current() *session {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.s
}

// notPlaying turns a call on a destroyed mpv into ErrNotPlaying.
func notPlaying(err error) error {
	if errors.Is(err, errDestroyed) {
		return ErrNotPlaying
	}
	return err
}

// update changes the state and has the event loop send it.
func (s *Service) update(change func(*State)) {
	s.mu.Lock()
	change(&s.state)
	s.stateDirty = true
	ses := s.s
	s.mu.Unlock()
	if ses != nil {
		ses.m.wakeup()
	} else {
		s.flush(nil)
	}
}

// --- the event loop ---------------------------------------------------------

// loop is the one goroutine that calls mpv_wait_event. It handles every
// event waiting, then sends what changed, so a burst of property changes
// becomes one EventState.
func (s *Service) loop(ses *session) {
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
			timeout = s.flush(ses)
		default:
			s.handle(ses, ev)
			timeout = 0
		}
	}
}

func (s *Service) handle(ses *session, ev mpvEvent) {
	switch ev.ID {
	case eventPropertyChange:
		s.property(ses, ev.Prop, ev.Value)
	case eventStartFile:
		ses.lastErr, ses.httpErr = "", ""
		ses.started = false
	case eventFileLoaded:
		ses.loaded = true
	case eventPlaybackRestart:
		// The first frame after a load or a seek.
		s.mu.Lock()
		s.state.Loading = false
		s.stateDirty, s.timeDirty, s.forceTime = true, true, true
		if ses.started {
			s.due(ReportSeeked)
			s.seeks++
		} else {
			s.due(ReportStarted)
		}
		ses.started = true
		s.mu.Unlock()
	case eventEndFile:
		// "stop" and "redirect" come from Stop or another Load.
		if ev.Reason != "eof" && ev.Reason != "error" {
			return
		}
		ses.loaded = false
		ended := &Ended{Reason: ev.Reason}
		if ev.Reason == "error" {
			ended.Code, ended.Message = endCode(mpvError(ev.Error), ses.httpErr), mpvError(ev.Error).Error()
			slog.Warn("player: file failed", "code", ended.Code, "error", ended.Message, "detail", ses.lastErr)
		}
		s.mu.Lock()
		s.state.Loading, s.state.Buffering, s.state.Seeking = false, false, false
		s.stateDirty, s.ended = true, ended
		if ev.Reason == "eof" && s.state.Duration > 0 {
			// time-pos stops a frame or so short of the end.
			s.state.Position = s.state.Duration
		}
		s.due(ReportEnded)
		s.mu.Unlock()
	case eventLogMessage:
		text := redact(strings.TrimSpace(ev.Text))
		// FFmpeg says "HTTP error 403" at warn, before mpv's error.
		if expired.MatchString(text) {
			ses.httpErr = text
		}
		if ev.Level == "error" || ev.Level == "fatal" {
			ses.lastErr = text
			slog.Warn("mpv: "+text, "module", ev.Prefix)
		} else {
			slog.Debug("mpv: "+text, "module", ev.Prefix, "level", ev.Level)
		}
	}
}

func (s *Service) property(ses *session, name string, v any) {
	switch name {
	case "vo-configured":
		on, _ := v.(bool)
		ses.host.videoConfigured(on)
		return
	case "video-params/w", "video-params/h":
		n, _ := v.(int64)
		s.mu.Lock()
		if name == "video-params/w" {
			s.videoW = int(n)
		} else {
			s.videoH = int(n)
		}
		s.mu.Unlock()
		s.applyCrop(ses)
		return
	case "video-params/gamma":
		trc, _ := v.(string)
		s.showHDR(ses, trc == "pq" || trc == "hlg")
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	st := &s.state
	switch name {
	case "time-pos":
		st.Position = number(v)
		s.timeDirty = true
		return
	case "duration":
		st.Duration = number(v)
		s.timeDirty = true
		return
	case "demuxer-cache-duration":
		st.Buffered = number(v)
		s.timeDirty = true
		return
	case "pause":
		paused, _ := v.(bool)
		if paused && !st.Paused && ses.loaded {
			s.due(ReportPaused)
		}
		if !paused && st.Paused && ses.loaded && ses.started {
			s.due(ReportResumed)
		}
		st.Paused = paused
	case "paused-for-cache":
		st.Buffering, _ = v.(bool)
	case "cache-buffering-state":
		st.BufferPercent = int(number(v))
	case "seeking":
		st.Seeking, _ = v.(bool)
	case "volume":
		st.Volume = number(v)
	case "mute":
		st.Muted, _ = v.(bool)
	case "speed":
		st.Speed = number(v)
	case "track-list":
		st.Tracks = tracks(v)
	case "chapter-list":
		st.Chapters = chapters(v)
	case "hwdec-current":
		st.HWDec, _ = v.(string)
		if st.HWDec == "no" {
			st.HWDec = ""
		}
	case "sub-delay":
		// mpv keeps it as a float32: -0.3 comes back as -0.30000001.
		st.SubtitleDelay = math.Round(number(v)*1000) / 1000
	case "sub-scale":
		st.SubtitleSize = subtitleSize(number(v))
	case "sub-text":
		st.SubtitleText, _ = v.(string)
	}
	s.stateDirty = true
}

// showHDR has an HDR video (PQ or HLG) go to the display as HDR when the
// host can show it, and every other video as before. mpv renders to BT.2100
// PQ for it, untouched, and the OS maps it to what the display can show.
// Otherwise mpv tone-maps HDR to SDR itself, as it does by default.
func (s *Service) showHDR(ses *session, hdr bool) {
	hdr = hdr && ses.host.canShowHDR()
	if hdr == ses.hdr {
		return
	}
	trc, prim := "auto", "auto"
	if hdr {
		trc, prim = "pq", "bt.2020"
	}
	for _, p := range [][2]string{{"target-trc", trc}, {"target-prim", prim}} {
		if err := ses.m.setProperty(p[0], p[1]); err != nil {
			slog.Warn("player: HDR not set", "error", err)
			return
		}
	}
	ses.host.showHDR(hdr)
	ses.hdr = hdr
	s.update(func(st *State) { st.HDR = hdr })
}

// flush sends what changed: the state, the time (throttled) and an end. It
// returns how long the loop may wait for events before calling it again,
// -1 for as long as it takes. A nil ses means there's no loop: send now.
func (s *Service) flush(ses *session) float64 {
	now := time.Now()
	wait := -1.0
	s.mu.Lock()
	var state *State
	if s.stateDirty {
		st := s.copyState()
		state, s.stateDirty = &st, false
	}
	var t *Time
	if s.timeDirty {
		if since := now.Sub(s.lastTime); s.forceTime || since >= TimeEvery {
			tm := s.state.Time
			t, s.timeDirty, s.forceTime, s.lastTime = &tm, false, false, now
		} else {
			wait = (TimeEvery - since).Seconds()
		}
	}
	ended := s.ended
	s.ended = nil
	playing := ses != nil && ses.loaded && !s.state.Paused
	if s.reportWhy == "" && playing && !s.state.Loading && now.Sub(s.lastReport) >= s.reportEvery {
		s.reportWhy = ReportPlaying
	}
	var report *Report
	if s.reportWhy != "" {
		report = s.reportNow(s.reportWhy)
		s.reportWhy, s.lastReport = "", now
	}
	// Not on time events: the controls extrapolate the position.
	media := s.media
	showMedia := media != nil && (state != nil || s.mediaDirty)
	var mediaNow *mediaState
	if showMedia {
		mediaNow, s.mediaDirty = s.mediaNow(), false
	}
	s.mu.Unlock()

	if ses != nil && playing != ses.playing {
		ses.playing = playing
		ses.host.playing(playing)
	}
	if state != nil {
		s.emit(EventState, *state)
	}
	if t != nil {
		s.emit(EventTime, *t)
	}
	if ended != nil {
		s.emit(EventEnded, *ended)
	}
	if showMedia {
		media.show(mediaNow)
	}
	s.sendReport(report)
	return wait
}

// --- progress reports (#64) -------------------------------------------------

// due asks the event loop for a report, keeping a pause, seek or end over a
// periodic one. Call with s.mu held.
func (s *Service) due(why string) {
	if s.reportWhy == "" || s.reportWhy == ReportPlaying {
		s.reportWhy = why
	}
}

// reportNow is a report of where the Watching file is, or nil when nothing
// is to be reported: no Watching, or a file whose length isn't known yet
// (still loading, or live). Call with s.mu held.
func (s *Service) reportNow(why string) *Report {
	if s.watching == nil || s.report == nil || s.state.Duration <= 0 {
		return nil
	}
	return &Report{
		Watching: *s.watching,
		Position: min(max(s.state.Position, 0), s.state.Duration),
		Duration: s.state.Duration,
		Why:      why,
	}
}

// stopReport is the report for a file being stopped or replaced. A file
// still loading after a Load reports nothing: its position is the start it
// was asked for, not one it played to.
func (s *Service) stopReport() *Report {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.state.Loading {
		return nil
	}
	return s.reportNow(ReportStopped)
}

func (s *Service) sendReport(report *Report) {
	if report == nil {
		return
	}
	s.mu.Lock()
	send := s.report
	s.mu.Unlock()
	send(*report)
}

// --- helpers ------------------------------------------------------------------

// expired matches FFmpeg's "HTTP error 403 Forbidden" and the like.
var expired = regexp.MustCompile(`HTTP error (401|403|404|410)\b`)

func endCode(err mpvError, httpErr string) string {
	switch {
	case httpErr != "":
		return EndExpired
	case err == errUnknownFormat || err == errNothingToPlay:
		return EndUnsupported
	}
	return EndFailed
}

var urls = regexp.MustCompile(`[a-zA-Z][a-zA-Z0-9+.-]*://\S+`)

// redact removes URLs from mpv's log messages: stream URLs carry debrid keys.
func redact(s string) string { return urls.ReplaceAllString(s, "<url>") }

func tracks(v any) []Track {
	list, _ := v.([]any)
	out := make([]Track, 0, len(list))
	for _, item := range list {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		str := func(k string) string { s, _ := m[k].(string); return s }
		b := func(k string) bool { v, _ := m[k].(bool); return v }
		out = append(out, Track{
			ID: int(number(m["id"])), Type: str("type"), Title: str("title"), Lang: str("lang"),
			Codec: str("codec"), Default: b("default"), Selected: b("selected"), External: b("external"),
			Forced: b("forced"), HearingImpaired: b("hearing-impaired"),
			Channels: int(number(m["demux-channel-count"])),
			Width:    int(number(m["demux-w"])), Height: int(number(m["demux-h"])),
		})
	}
	return out
}

func chapters(v any) []Chapter {
	list, _ := v.([]any)
	out := make([]Chapter, 0, len(list))
	for _, item := range list {
		m, _ := item.(map[string]any)
		if m == nil {
			continue
		}
		title, _ := m["title"].(string)
		out = append(out, Chapter{Title: title, Time: number(m["time"])})
	}
	return out
}

// subtitleSize names a sub-scale, or "" for one no size has.
func subtitleSize(scale float64) string {
	for size, s := range subtitleScales {
		if math.Abs(scale-s) < 0.001 {
			return size
		}
	}
	return ""
}

func number(v any) float64 {
	switch n := v.(type) {
	case float64:
		return n
	case int64:
		return float64(n)
	}
	return 0
}

func flag(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

// seconds formats a number the way mpv parses it (LC_NUMERIC is "C").
func seconds(f float64) string { return strconv.FormatFloat(f, 'f', -1, 64) }

// MarshalError gives the frontend an error's code.
func MarshalError(err error) []byte {
	code := CodeUnavailable
	switch {
	case errors.Is(err, ErrInvalid):
		code = CodeInvalid
	case errors.Is(err, ErrNotPlaying):
		code = CodeNotPlaying
	case errors.Is(err, ErrSubtitles):
		code = CodeSubtitles
	}
	data, _ := json.Marshal(map[string]string{"code": code})
	return data
}
