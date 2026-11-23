// Package playback is the part of the player that has no video engine in it:
// the state, options, errors and reports the frontend and the rest of the
// app speak (ADR-0039, ADR-0055). The desktop engine (internal/player, libmpv
// under the webview) and the iOS one both produce and take these, and
// watching, tracking and the watch party import this package rather than the
// engine, so the iOS build never links libmpv or AppKit.
package playback

import (
	"encoding/json"
	"errors"
	"math"
	"regexp"
	"slices"
	"time"

	"github.com/k22i/Peli/internal/store"
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

// Error codes the frontend reads (MarshalError) for an addon's subtitles.
// ErrSubtitles means an addon's subtitles couldn't be added: the download
// failed, or mpv couldn't read the file.
var ErrSubtitles = errors.New("player: subtitles couldn't be loaded")

// CodeSubtitles is ErrSubtitles' code for the frontend.
const CodeSubtitles = "subtitles"

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
	// SecondarySubtitleText is the second subtitle track's line showing now.
	// mpv doesn't draw it (secondary-sub-visibility is off: it can't be
	// sized or placed); the screen does, above the main subtitles.
	SecondarySubtitleText string `json:"secondarySubtitleText"`
	// HWDec is the hardware decoder in use, "" for software.
	HWDec string `json:"hwdec"`
	// HDR is true while an HDR video goes to the display as HDR, rather
	// than tone-mapped to SDR (#66).
	HDR bool `json:"hdr"`
	// AutoCrop is the crop auto-crop found for the file, in percent; nil
	// until it finds one, or when it's off.
	AutoCrop *store.Crop `json:"autoCrop,omitempty"`
	// AudioDelay is how far the sound is moved after the picture, in
	// seconds (rounded to ms), for this session.
	AudioDelay float64 `json:"audioDelay"`
	// VolumeMax is the loudest the volume goes: 100, or 150 with the
	// device's volume boost.
	VolumeMax float64 `json:"volumeMax"`
	// LoopA and LoopB are the A–B loop's ends, in seconds, nil while unset:
	// with both, mpv plays from A to B over and over (SetLoop).
	LoopA *float64 `json:"loopA"`
	LoopB *float64 `json:"loopB"`
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
	ID      int    `json:"id"`
	Type    string `json:"type"` // "video", "audio" or "sub"
	Title   string `json:"title"`
	Lang    string `json:"lang"`
	Codec   string `json:"codec"`
	Default bool   `json:"default"`
	// Selected is true for the audio or video track playing and the subtitle
	// track showing as the main one; Secondary is the subtitle track
	// feeding the second line (SetSecondarySubtitleTrack).
	Selected  bool `json:"selected"`
	Secondary bool `json:"secondary"`
	External  bool `json:"external"`
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
	// Quality is how hard the renderer works; nil is the title's own, else
	// this device's.
	Quality *store.Quality `json:"quality,omitempty"`
	// Sound is how it sounds; nil is the title's own, else the profile's.
	Sound *store.Sound `json:"sound,omitempty"`
	// Watching names what the file is, so how far it plays is reported
	// (#64); nil for a file nobody keeps progress of.
	Watching *Watching `json:"watching,omitempty"`
}

// Watching is the film or episode a file plays, as the profile's progress

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

const ReportEvery = 10 * time.Second

// SubtitleScales are mpv's sub-scale for each SubtitleSize.
var SubtitleScales = map[string]float64{"small": 0.75, "medium": 1, "large": 1.35}

// MaxSubtitleDelay bounds SetSubtitleDelay, in seconds either way.
const MaxSubtitleDelay = 600

var languageCode = regexp.MustCompile(`^([a-z]{2,3})?$`)

// Valid reports whether the options are in range.
func (o LoadOptions) Valid() bool {
	_, sized := SubtitleScales[o.SubtitleSize]
	return o.Start >= 0 && !math.IsNaN(o.Start) &&
		// Codes only: mpv's alang and slang are lists, split on commas.
		LanguageValid(o.SubtitleLanguage) && AudioLanguagesValid(o.AudioLanguages) &&
		(o.Captions == "" || o.Captions == "system" || o.Captions == "on" || o.Captions == "off") &&
		(o.SubtitleSize == "" || sized) && (o.SubtitleStyle == nil || o.SubtitleStyle.Valid()) &&
		(o.Picture == nil || o.Picture.Valid()) && (o.Framing == nil || o.Framing.Valid()) &&
		(o.Quality == nil || o.Quality.Valid()) && (o.Sound == nil || o.Sound.Valid()) &&
		(o.Watching == nil || (o.Watching.ContentID != "" && o.Watching.ContentType != ""))
}

// LanguageValid reports whether code is an ISO 639 code, or empty.
func LanguageValid(code string) bool { return languageCode.MatchString(code) }

// AudioLanguagesValid reports whether every one of codes is a code, and none
// is empty: an empty entry would end mpv's list early.
func AudioLanguagesValid(codes []string) bool {
	for _, code := range codes {
		if code == "" || !languageCode.MatchString(code) {
			return false
		}
	}
	return true
}

// SubtitleStyle is how text subtitles look: the profile's choice,
// applied at every load and changed live from the player. Subtitles that
// bring their own styling (ASS) keep it unless Override is on.
type SubtitleStyle struct {
	// Font is "sans", "serif" or "mono": a face this OS has for each.
	Font string `json:"font"`
	// Size is a percentage of mpv's own size, 50–200.
	Size int `json:"size"`
	// Color is the text's "#RRGGBB".
	Color string `json:"color"`
	// Edge is how the text stands off the picture: "none", "outline",
	// "shadow" or "box".
	Edge string `json:"edge"`
	// Backdrop is the box's opacity for Edge "box", 0–100.
	Backdrop int `json:"backdrop"`
	// Lift raises the subtitles from their usual place, in percent of the
	// picture's height, 0–30.
	Lift int  `json:"lift"`
	Bold bool `json:"bold"`
	// Override restyles subtitles that bring their own styling too.
	Override bool `json:"override"`
}

// SubtitleFonts and SubtitleEdges are a SubtitleStyle's choices.
var (
	SubtitleFonts = []string{"sans", "serif", "mono"}
	SubtitleEdges = []string{"none", "outline", "shadow", "box"}
	hexRGB        = regexp.MustCompile(`^#[0-9A-Fa-f]{6}$`)
)

// Valid reports whether the style is in range.
func (st SubtitleStyle) Valid() bool {
	return slices.Contains(SubtitleFonts, st.Font) && st.Size >= 50 && st.Size <= 200 &&
		hexRGB.MatchString(st.Color) && slices.Contains(SubtitleEdges, st.Edge) &&
		st.Backdrop >= 0 && st.Backdrop <= 100 && st.Lift >= 0 && st.Lift <= 30
}

// Subtitle is a subtitle file from an addon (#63), as AddSubtitle takes it.
type Subtitle struct {
	URL string `json:"url"`
	// Lang is an ISO 639 code ("en", "por"), or "" if the addon's isn't one.
	Lang string `json:"lang"`
	// Title names it in the track list, such as the addon's name.
	Title string `json:"title"`
	// Secondary adds it as the second line (dual subtitles) and leaves the
	// main subtitles as they are.
	Secondary bool `json:"secondary"`
	// AutoSync lines the file up with the video's own subtitles first
	// (internal/subsync), when the video has some; SubtitleSync says how
	// it went.
	AutoSync bool `json:"autoSync"`
}

// Stats is what the stats overlay (Shift+I) shows of the file playing and
// how it plays. Numbers mpv doesn't know (yet) are 0, strings "". The
// frontend asks once a second, and only while the overlay is open: each
// call reads a dozen properties from mpv.
type Stats struct {
	// The video: codec ("hevc"), its size, frames a second and pixel
	// format ("yuv420p10", the hardware decoder's own where there is one).
	VideoCodec  string  `json:"videoCodec"`
	Width       int     `json:"width"`
	Height      int     `json:"height"`
	FPS         float64 `json:"fps"`
	PixelFormat string  `json:"pixelFormat"`
	// The picture's colour: transfer ("pq", "hlg", "bt.1886"), primaries
	// ("bt.2020") and matrix ("dolbyvision" for Dolby Vision), mpv's names.
	Gamma       string `json:"gamma"`
	Primaries   string `json:"primaries"`
	ColorMatrix string `json:"colorMatrix"`
	// HDRShown is whether it goes to the display as HDR (#66) rather than
	// tone-mapped.
	HDRShown bool `json:"hdrShown"`
	// The size it's drawn at in the window.
	OutputWidth  int `json:"outputWidth"`
	OutputHeight int `json:"outputHeight"`
	// HWDec is the hardware decoder in use, "" for software.
	HWDec string `json:"hwdec"`
	// Frames dropped: by the renderer to keep in sync, and by the decoder
	// when it falls behind.
	DroppedFrames int64 `json:"droppedFrames"`
	DecoderDrops  int64 `json:"decoderDrops"`
	// The sound: codec ("eac3") and channels.
	AudioCodec    string `json:"audioCodec"`
	AudioChannels int    `json:"audioChannels"`
	// Bitrates, in bits a second, as the demuxer measures them.
	VideoBitrate float64 `json:"videoBitrate"`
	AudioBitrate float64 `json:"audioBitrate"`
	// The cache ahead: seconds, bytes, and how fast it fills, in bytes a
	// second.
	CacheSeconds float64 `json:"cacheSeconds"`
	CacheBytes   int64   `json:"cacheBytes"`
	CacheSpeed   float64 `json:"cacheSpeed"`
	// The renderer: mpv's VO ("libmpv", "gpu-next") and its GPU context
	// ("d3d11"), "" where the render API has none to name.
	Renderer   string  `json:"renderer"`
	GPUContext string  `json:"gpuContext"`
	DisplayFPS float64 `json:"displayFps"`
}

// AudioDevice is an output mpv can play to.
type AudioDevice struct {
	Name        string `json:"name"`
	Description string `json:"description"`
}

// NowPlaying names what plays, for the OS's media controls: the title, and
// for an episode its code and name ("S1E2 · Pilot").
type NowPlaying struct {
	Title    string `json:"title"`
	Subtitle string `json:"subtitle"`
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
	// UserLoop is asked before an A–B loop is set (not cleared).
	UserLoop() bool
}

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

// SecondaryIs reports whether the subtitle track with id is the second one.
func (st State) SecondaryIs(id int) bool {
	for _, track := range st.Tracks {
		if track.ID == id && track.Type == "sub" && track.Secondary {
			return true
		}
	}
	return false
}
