//go:build !ios

package player

import (
	"errors"
	"math"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"slices"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/k22i/Peli/internal/streams"
)

// The fixtures are 3 s of 320x180 H.264 at 24 fps with AAC audio (English):
// clip.mp4, and the same cut into 1 s HLS segments in hls/. tracks.mkv
// adds tracks to it (#62).
const clipSeconds = 3.0

// recorder is a Service's event sink.
type recorder struct {
	mu     sync.Mutex
	states []State
	times  []Time
	ends   []Ended
	timeAt []time.Time
	signal chan struct{}
}

func newRecorder() *recorder { return &recorder{signal: make(chan struct{}, 1)} }

func (r *recorder) emit(name string, data any) {
	r.mu.Lock()
	switch name {
	case EventState:
		r.states = append(r.states, data.(State))
	case EventTime:
		r.times = append(r.times, data.(Time))
		r.timeAt = append(r.timeAt, time.Now())
	case EventEnded:
		r.ends = append(r.ends, data.(Ended))
	}
	r.mu.Unlock()
	select {
	case r.signal <- struct{}{}:
	default:
	}
}

// waitFor waits until ok holds for what was recorded.
func (r *recorder) waitFor(t *testing.T, what string, ok func(r *recorder) bool) {
	t.Helper()
	deadline := time.After(15 * time.Second)
	for {
		r.mu.Lock()
		done := ok(r)
		r.mu.Unlock()
		if done {
			return
		}
		select {
		case <-r.signal:
		case <-deadline:
			t.Fatalf("timed out waiting for %s", what)
		}
	}
}

func (r *recorder) last() State {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.states) == 0 {
		return State{}
	}
	return r.states[len(r.states)-1]
}

// newTestService returns a Service that plays without video or audio
// output, and closes it when the test ends.
func newTestService(t *testing.T) (*Service, *recorder) {
	t.Helper()
	r := newRecorder()
	s := NewService("test")
	s.newHost = func() (host, error) { return nullHost{}, nil }
	s.emit = r.emit
	t.Cleanup(func() {
		if err := s.Stop(); err != nil {
			t.Errorf("Stop: %v", err)
		}
	})
	return s, r
}

func playsToTheEnd(t *testing.T, s *Service, r *recorder) {
	t.Helper()
	r.waitFor(t, "the first frame", func(r *recorder) bool {
		for _, st := range r.states {
			if st.Active && !st.Loading && st.Duration > 0 {
				return true
			}
		}
		return false
	})
	r.waitFor(t, "the end", func(r *recorder) bool { return len(r.ends) > 0 })
	r.mu.Lock()
	defer r.mu.Unlock()
	if got := r.ends[0]; got.Reason != "eof" {
		t.Fatalf("ended %+v, want eof", got)
	}
	st := r.states[len(r.states)-1]
	if d := st.Duration; d < clipSeconds-0.1 || d > clipSeconds+0.1 {
		t.Errorf("duration %v, want ~%v", d, clipSeconds)
	}
	// mpv empties track-list once the file ends, so look at every state.
	var video, audio bool
	var all []Track
	for _, st := range r.states {
		all = append(all, st.Tracks...)
	}
	for _, tr := range all {
		video = video || tr.Type == "video" && tr.Width == 320 && tr.Height == 180
		audio = audio || tr.Type == "audio" && tr.Lang == "eng"
	}
	if !video || !audio {
		t.Errorf("tracks %+v, want 320x180 video and English audio", all)
	}
	var max float64
	for _, tm := range r.times {
		max = maxf(max, tm.Position)
	}
	if max < clipSeconds-0.5 {
		t.Errorf("time events reached %v s, want near %v", max, clipSeconds)
	}
}

func maxf(a, b float64) float64 {
	if a > b {
		return a
	}
	return b
}

func TestPlaysALocalFile(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/clip.mp4")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	playsToTheEnd(t, s, r)
}

// server serves testdata, and only to requests that send the headers and
// User-Agent a resolved Source names.
func server(t *testing.T, requests *atomic.Int64) (*httptest.Server, streams.Source) {
	t.Helper()
	files := http.FileServer(http.Dir("testdata"))
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		if r.Header.Get("X-Token") != "a, b" || r.UserAgent() != "Peli/test-ua" {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		files.ServeHTTP(w, r)
	}))
	t.Cleanup(srv.Close)
	return srv, streams.Source{
		Headers:   map[string]string{"X-Token": "a, b"}, // a comma, which mpv's string form splits on
		UserAgent: "Peli/test-ua",
	}
}

func TestPlaysOverHTTPWithTheSourcesHeaders(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	var requests atomic.Int64
	srv, source := server(t, &requests)
	source.URL = srv.URL + "/clip.mp4"
	if err := s.Load(source, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	playsToTheEnd(t, s, r)
}

func TestPlaysHLSWithTheSourcesHeaders(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	var requests atomic.Int64
	srv, source := server(t, &requests)
	source.URL = srv.URL + "/hls/index.m3u8"
	if err := s.Load(source, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	playsToTheEnd(t, s, r)
	// The playlist and its three segments, each with the headers.
	if n := requests.Load(); n < 4 {
		t.Errorf("%d requests, want the playlist and 3 segments", n)
	}
}

// Not parallel: libmpv sends FFmpeg's log messages, which say a link
// expired, to one mpv instance per process only. The app has one at a time.
func TestAnExpiredLinkEndsWithExpired(t *testing.T) {
	s, r := newTestService(t)
	var requests atomic.Int64
	srv, source := server(t, &requests)
	source.URL = srv.URL + "/clip.mp4"
	source.Headers = nil // refused with a 403
	if err := s.Load(source, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the end", func(r *recorder) bool { return len(r.ends) > 0 })
	if got := r.ends[0]; got.Reason != "error" || got.Code != EndExpired {
		t.Errorf("ended %+v, want an error with code %q", got, EndExpired)
	}
	if st := r.last(); st.Loading || !st.Active {
		t.Errorf("state %+v, want active and not loading", st)
	}
}

func TestAFileItCantPlayEndsWithUnsupported(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("player.go")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the end", func(r *recorder) bool { return len(r.ends) > 0 })
	if got := r.ends[0]; got.Reason != "error" || got.Code != EndUnsupported {
		t.Errorf("ended %+v, want an error with code %q", got, EndUnsupported)
	}
}

func TestControls(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/clip.mp4")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Start: 1}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(r *recorder) bool {
		st := r.states
		return len(st) > 0 && !st[len(st)-1].Loading && st[len(st)-1].Duration > 0
	})
	if pos := s.Snapshot().Position; pos < 0.9 {
		t.Errorf("started at %v, want 1", pos)
	}
	for _, step := range []struct {
		name string
		call func() error
		ok   func(State) bool
	}{
		{"pause", func() error { return s.SetPaused(true) }, func(st State) bool { return st.Paused }},
		{"seek", func() error { return s.Seek(2.5) }, func(st State) bool { return st.Position > 2.4 && st.Position < 2.6 }},
		{"seek back", func() error { return s.SeekBy(-2) }, func(st State) bool { return st.Position > 0.4 && st.Position < 0.6 }},
		// The clip's keyframes are 1 s apart: a scrub lands on one.
		{"scrub", func() error { return s.Scrub(1.8) }, func(st State) bool { return math.Abs(st.Position-math.Round(st.Position)) < 0.05 }},
		{"volume", func() error { return s.SetVolume(40) }, func(st State) bool { return st.Volume == 40 }},
		{"mute", func() error { return s.SetMuted(true) }, func(st State) bool { return st.Muted }},
		{"speed", func() error { return s.SetSpeed(1.5) }, func(st State) bool { return st.Speed == 1.5 }},
	} {
		if err := step.call(); err != nil {
			t.Fatalf("%s: %v", step.name, err)
		}
		r.waitFor(t, step.name, func(*recorder) bool { return step.ok(s.Snapshot()) })
	}
	// Paused, so the end never comes.
	time.Sleep(300 * time.Millisecond)
	r.mu.Lock()
	ends := len(r.ends)
	r.mu.Unlock()
	if ends != 0 {
		t.Errorf("%d ends while paused", ends)
	}
	for _, bad := range []func() error{
		func() error { return s.SetVolume(101) },
		func() error { return s.SetSpeed(0) },
		func() error { return s.Seek(-1) },
		func() error { return s.Scrub(math.NaN()) },
		func() error { return s.Load(streams.Source{}, LoadOptions{}) },
	} {
		if err := bad(); !errors.Is(err, ErrInvalid) {
			t.Errorf("got %v, want ErrInvalid", err)
		}
	}
}

func TestTimeEventsAreThrottled(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/clip.mp4")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the end", func(r *recorder) bool { return len(r.ends) > 0 })
	r.mu.Lock()
	defer r.mu.Unlock()
	// 24 fps for 3 s is 72 time-pos changes; at most ~4 a second get out,
	// plus one after the first frame.
	if n := len(r.times); n > 16 || n < 6 {
		t.Errorf("%d time events for %v s, want about 4 a second", n, clipSeconds)
	}
	for i := 2; i < len(r.timeAt); i++ {
		if gap := r.timeAt[i].Sub(r.timeAt[i-1]); gap < TimeEvery-20*time.Millisecond {
			t.Errorf("time events %d and %d %v apart", i-1, i, gap)
		}
	}
}

func TestLoadingAnotherFileDoesntEndTheSession(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/clip.mp4")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { st := s.Snapshot(); return !st.Loading && st.Duration > 0 })
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Start: 2}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the end", func(r *recorder) bool { return len(r.ends) > 0 })
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.ends) != 1 || r.ends[0].Reason != "eof" {
		t.Errorf("ends %+v, want one eof (the replaced file sends none)", r.ends)
	}
}

func TestStopClosesTheSession(t *testing.T) {
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/clip.mp4")
	if err := s.SetPaused(true); !errors.Is(err, ErrNotPlaying) {
		t.Errorf("SetPaused before Load: %v, want ErrNotPlaying", err)
	}
	before := runtime.NumGoroutine()
	for i := range 10 {
		if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
			t.Fatal(err)
		}
		if i%2 == 0 {
			// Half the time, stop mid-play rather than straight away.
			r.waitFor(t, "the first frame", func(*recorder) bool { return !s.Snapshot().Loading })
		}
		if err := s.Stop(); err != nil {
			t.Fatal(err)
		}
		// Not parallel: the parallel tests wait until this one is done.
		if n := liveHandles.Load(); n != 0 {
			t.Fatalf("%d mpv handles alive after Stop", n)
		}
	}
	if st := r.last(); st.Active || st.Loading {
		t.Errorf("state after Stop %+v, want inactive", st)
	}
	if err := s.SetPaused(true); !errors.Is(err, ErrNotPlaying) {
		t.Errorf("SetPaused after Stop: %v, want ErrNotPlaying", err)
	}
	// The event loops have exited.
	deadline := time.Now().Add(2 * time.Second)
	for runtime.NumGoroutine() > before && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if after := runtime.NumGoroutine(); after > before {
		t.Errorf("%d goroutines after, %d before", after, before)
	}
}

func TestTheMiniPlayerNeedsTheWindow(t *testing.T) {
	t.Parallel()
	s, _ := newTestService(t)
	for _, on := range []bool{true, false} {
		if err := s.SetMini(on); !errors.Is(err, ErrUnavailable) {
			t.Errorf("SetMini(%v) without a window: %v, want ErrUnavailable", on, err)
		}
	}
	if s.Snapshot().Mini {
		t.Error("Mini is on without a window")
	}
}

func TestRedact(t *testing.T) {
	got := redact("Opening https://torrentio.strem.fun/realdebrid=KEY/abc/1/file.mkv failed")
	if strings.Contains(got, "KEY") || got != "Opening <url> failed" {
		t.Errorf("redact: %q", got)
	}
}

func TestChapters(t *testing.T) {
	got := chapters([]any{
		map[string]any{"title": "Prologue", "time": 0.0},
		map[string]any{"title": "Opening", "time": 61.5},
		map[string]any{"time": int64(150)},
		"not a chapter",
	})
	want := []Chapter{{Title: "Prologue"}, {Title: "Opening", Time: 61.5}, {Time: 150}}
	if !slices.Equal(got, want) {
		t.Fatalf("chapters = %+v; want %+v", got, want)
	}
	if got := chapters(nil); got == nil || len(got) != 0 {
		t.Fatalf("chapters(nil) = %#v; want empty", got)
	}
}

func TestMarshalError(t *testing.T) {
	for err, want := range map[error]string{
		ErrInvalid: CodeInvalid, ErrNotPlaying: CodeNotPlaying, ErrUnavailable: CodeUnavailable,
		ErrSubtitles: CodeSubtitles,
	} {
		if got := string(MarshalError(err)); got != `{"code":"`+want+`"}` {
			t.Errorf("MarshalError(%v) = %s", err, got)
		}
	}
}

// tracks.mkv is the clip with English (default) and Japanese audio, and
// English (default), Japanese and forced English ("Signs") subtitles.
func TestPicksTracksByLanguageAndCaptions(t *testing.T) {
	t.Parallel()
	path, _ := filepath.Abs("testdata/tracks.mkv")
	for name, c := range map[string]struct {
		opts       LoadOptions
		audio, sub int // track ids; sub 0 is none
	}{
		"defaults, captions off":   {LoadOptions{Captions: "off"}, 1, 3},
		"captions on":              {LoadOptions{Captions: "on"}, 1, 1},
		"Japanese, captions off":   {LoadOptions{AudioLanguages: []string{"ja"}, Captions: "off"}, 2, 0},
		"Japanese, English on":     {LoadOptions{AudioLanguages: []string{"ja"}, SubtitleLanguage: "en", Captions: "on"}, 2, 1},
		"Japanese subtitles on":    {LoadOptions{SubtitleLanguage: "jpn", Captions: "on"}, 1, 2},
		"a language it hasn't":     {LoadOptions{AudioLanguages: []string{"fr"}, SubtitleLanguage: "fr", Captions: "on"}, 1, 1},
		"first one it has":         {LoadOptions{AudioLanguages: []string{"fr", "ja", "en"}, Captions: "off"}, 2, 0},
		"later one when no first":  {LoadOptions{AudioLanguages: []string{"fr", "en"}, Captions: "off"}, 1, 3},
		"off ignores the language": {LoadOptions{SubtitleLanguage: "ja", Captions: "off"}, 1, 3},
	} {
		t.Run(name, func(t *testing.T) {
			t.Parallel()
			s, r := newTestService(t)
			if err := s.Load(streams.Source{URL: path}, c.opts); err != nil {
				t.Fatal(err)
			}
			r.waitFor(t, "the first frame", func(*recorder) bool {
				st := s.Snapshot()
				return !st.Loading && len(st.Tracks) > 0
			})
			audio, sub := 0, 0
			for _, tr := range s.Snapshot().Tracks {
				switch {
				case tr.Selected && tr.Type == "audio":
					audio = tr.ID
				case tr.Selected && tr.Type == "sub":
					sub = tr.ID
				}
			}
			if audio != c.audio || sub != c.sub {
				t.Errorf("audio %d and subtitles %d, want %d and %d", audio, sub, c.audio, c.sub)
			}
		})
	}
}

func TestSystemCaptions(t *testing.T) {
	defer func(f func() bool) { systemCaptions = f }(systemCaptions)
	for _, on := range []bool{false, true} {
		systemCaptions = func() bool { return on }
		for mode, want := range map[string]bool{"": on, "system": on, "on": true, "off": false} {
			props := trackProps(LoadOptions{Captions: mode})
			if got := props[4][1] == "yes"; got != want {
				t.Errorf("system %v, captions %q: subtitles on %v, want %v (%v)", on, mode, got, want, props)
			}
		}
	}
}

// A new file shows its subtitles: off is a hidden track, not a deselect, which
// mpv 0.41 refresh-seeks on.
func TestTrackPropsStartShown(t *testing.T) {
	for _, o := range []LoadOptions{{}, {Captions: "on", SubtitleLanguage: "en"}, {SubtitleSize: "large"}} {
		props := trackProps(o)
		if last := props[len(props)-1]; last[0] != "sub-visibility" || last[1] != "yes" {
			t.Errorf("%+v: last property %v, want sub-visibility yes", o, last)
		}
		// Appended, not inserted: the captions pick these by index.
		if props[4][0] != "subs-fallback" {
			t.Errorf("%+v: the track properties moved (%v)", o, props)
		}
	}
}

func TestTrackControls(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	path, _ := filepath.Abs("testdata/tracks.mkv")
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Captions: "on", SubtitleSize: "small"}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { st := s.Snapshot(); return !st.Loading && len(st.Tracks) > 0 })
	if err := s.SetPaused(true); err != nil {
		t.Fatal(err)
	}
	if size := s.Snapshot().SubtitleSize; size != "small" {
		t.Errorf("subtitle size %q, want small", size)
	}
	selected := func(kind string) int {
		for _, tr := range s.Snapshot().Tracks {
			if tr.Type == kind && tr.Selected {
				return tr.ID
			}
		}
		return 0
	}
	for _, step := range []struct {
		name string
		call func() error
		ok   func(State) bool
	}{
		{"audio", func() error { return s.SetAudioTrack(2) }, func(State) bool { return selected("audio") == 2 }},
		{"subtitles", func() error { return s.SetSubtitleTrack(2) }, func(State) bool { return selected("sub") == 2 }},
		{"subtitles off", func() error { return s.SetSubtitleTrack(0) }, func(State) bool { return selected("sub") == 0 }},
		{"delay", func() error { return s.SetSubtitleDelay(-0.3) }, func(st State) bool { return math.Abs(st.SubtitleDelay+0.3) < 1e-9 }},
		{"size", func() error { return s.SetSubtitleSize("large") }, func(st State) bool { return st.SubtitleSize == "large" }},
	} {
		if err := step.call(); err != nil {
			t.Fatalf("%s: %v", step.name, err)
		}
		r.waitFor(t, step.name, func(*recorder) bool { return step.ok(s.Snapshot()) })
	}
	var forced bool
	for _, tr := range s.Snapshot().Tracks {
		forced = forced || tr.Forced && tr.Title == "Signs"
	}
	if !forced {
		t.Errorf("tracks %+v, want the forced Signs track", s.Snapshot().Tracks)
	}
	for _, bad := range []func() error{
		func() error { return s.SetAudioTrack(0) },
		func() error { return s.SetSubtitleTrack(-1) },
		func() error { return s.SetSubtitleDelay(math.NaN()) },
		func() error { return s.SetSubtitleDelay(MaxSubtitleDelay + 1) },
		func() error { return s.SetSubtitleSize("huge") },
		func() error { return s.Load(streams.Source{URL: path}, LoadOptions{AudioLanguages: []string{"en,ja"}}) },
		func() error {
			return s.Load(streams.Source{URL: path}, LoadOptions{AudioLanguages: []string{"en", ""}})
		},
		func() error { return s.Load(streams.Source{URL: path}, LoadOptions{Captions: "sometimes"}) },
		func() error { return s.Load(streams.Source{URL: path}, LoadOptions{SubtitleSize: "huge"}) },
	} {
		if err := bad(); !errors.Is(err, ErrInvalid) {
			t.Errorf("got %v, want ErrInvalid", err)
		}
	}
}

// reports collects a Service's progress reports (#64).
type reports struct {
	mu   sync.Mutex
	list []Report
}

func (r *reports) add(rep Report) {
	r.mu.Lock()
	r.list = append(r.list, rep)
	r.mu.Unlock()
}

func (r *reports) whys() []string {
	r.mu.Lock()
	defer r.mu.Unlock()
	var whys []string
	for _, rep := range r.list {
		whys = append(whys, rep.Why)
	}
	return whys
}

func (r *reports) last() Report {
	r.mu.Lock()
	defer r.mu.Unlock()
	if len(r.list) == 0 {
		return Report{}
	}
	return r.list[len(r.list)-1]
}

// A Watching file reports while it plays, when it pauses, lands after a seek,
// and is stopped; a file without one reports nothing.
func TestReportsProgress(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	got := &reports{}
	ReportTo(s, got.add)
	s.reportEvery = 500 * time.Millisecond
	path, _ := filepath.Abs("testdata/clip.mp4")

	if err := s.Load(streams.Source{URL: path}, LoadOptions{}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the first frame", func(*recorder) bool { st := s.Snapshot(); return !st.Loading && st.Duration > 0 })
	if err := s.SetPaused(true); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the pause", func(*recorder) bool { return s.Snapshot().Paused })
	time.Sleep(200 * time.Millisecond)
	if whys := got.whys(); len(whys) != 0 {
		t.Fatalf("a file with no Watching reported %v", whys)
	}

	w := Watching{ProfileID: 1, ContentID: "tt0903747", ContentType: "series", VideoID: "tt0903747:2:4", Season: intp(2), Episode: intp(4)}
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Start: 0.5, Watching: &w}); err != nil {
		t.Fatal(err)
	}
	wait := func(what string, ok func([]string) bool) {
		t.Helper()
		deadline := time.Now().Add(10 * time.Second)
		for !ok(got.whys()) {
			if time.Now().After(deadline) {
				t.Fatalf("timed out waiting for %s: %v", what, got.whys())
			}
			time.Sleep(10 * time.Millisecond)
		}
	}
	has := func(why string) func([]string) bool {
		return func(whys []string) bool { return slices.Contains(whys, why) }
	}
	wait("a report while playing", has(ReportPlaying))
	// The first frame starts it, for SIMKL (#73).
	if whys := got.whys(); whys[0] != ReportStarted {
		t.Fatalf("reports %v, want the start first", whys)
	}
	if rep := got.last(); rep.Watching.VideoID != w.VideoID || *rep.Watching.Season != 2 ||
		rep.Duration < clipSeconds-0.1 || rep.Position < 0.5 || rep.Position > rep.Duration {
		t.Fatalf("report %+v", rep)
	}
	if err := s.Seek(0.2); err != nil {
		t.Fatal(err)
	}
	wait("the seek", has(ReportSeeked))
	if err := s.SetPaused(true); err != nil {
		t.Fatal(err)
	}
	wait("the pause", has(ReportPaused))
	if err := s.SetPaused(false); err != nil {
		t.Fatal(err)
	}
	wait("playing again", has(ReportResumed))
	if err := s.SetPaused(true); err != nil {
		t.Fatal(err)
	}
	wait("the second pause", func(whys []string) bool { return whys[len(whys)-1] == ReportPaused })
	if err := s.Stop(); err != nil {
		t.Fatal(err)
	}
	if rep := got.last(); rep.Why != ReportStopped || rep.Position < 0.2 || rep.Position > 1.5 {
		t.Fatalf("last report %+v, want stopped where it paused", rep)
	}
	// A pause before the file played is nothing: only the ones asked for.
	if whys := got.whys(); slices.Index(whys, ReportPaused) < slices.Index(whys, ReportSeeked) ||
		whys[len(whys)-2] != ReportPaused {
		t.Fatalf("reports %v", whys)
	}
}

// Played to the end, a Watching file reports the whole of it, so it's
// marked watched.
func TestReportsTheEnd(t *testing.T) {
	t.Parallel()
	s, r := newTestService(t)
	got := &reports{}
	ReportTo(s, got.add)
	path, _ := filepath.Abs("testdata/clip.mp4")
	w := Watching{ProfileID: 1, ContentID: "tt1160419", ContentType: "movie", VideoID: "tt1160419"}
	if err := s.Load(streams.Source{URL: path}, LoadOptions{Start: 2, Watching: &w}); err != nil {
		t.Fatal(err)
	}
	r.waitFor(t, "the end", func(r *recorder) bool { return len(r.ends) > 0 })
	deadline := time.Now().Add(5 * time.Second)
	for got.last().Why != ReportEnded {
		if time.Now().After(deadline) {
			t.Fatalf("reports %v, want one at the end", got.whys())
		}
		time.Sleep(10 * time.Millisecond)
	}
	if rep := got.last(); rep.Position != rep.Duration || rep.Duration < clipSeconds-0.1 {
		t.Fatalf("report at the end %+v, want the whole duration", rep)
	}
	if whys := got.whys(); slices.Contains(whys, ReportSeeked) {
		t.Fatalf("reports %v: starting at a position isn't a seek", whys)
	}
}

func intp(n int) *int { return &n }
