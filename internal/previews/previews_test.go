package previews

import (
	"context"
	"errors"
	"image"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/k22i/Peli/internal/streams"
)

// fakeGrabber is a Grabber that returns a flat 32×18 frame for whatever time
// it is asked for, with a scripted list of errors to hand back first. gate
// holds its first Grab open, for the test that needs one slow decode; held is
// closed when that Grab starts waiting.
type fakeGrabber struct {
	duration float64
	errs     []error
	gate     chan struct{}
	held     chan struct{}

	mu     sync.Mutex
	grabs  []float64
	closed bool
}

func (f *fakeGrabber) Duration() float64 { return f.duration }

func (f *fakeGrabber) Grab(ctx context.Context, sec float64) (Frame, error) {
	f.mu.Lock()
	f.grabs = append(f.grabs, sec)
	var err error
	if len(f.errs) > 0 {
		err, f.errs = f.errs[0], f.errs[1:]
	}
	gate, held := f.gate, f.held
	f.gate, f.held = nil, nil
	f.mu.Unlock()

	if gate != nil {
		if held != nil {
			close(held)
		}
		select {
		case <-gate:
		case <-ctx.Done():
			return Frame{}, ctx.Err()
		}
	}
	if err != nil {
		return Frame{}, err
	}
	img := image.NewNRGBA(image.Rect(0, 0, 32, 18))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = 0x40, 0x80, 0xc0, 0xff
	}
	return Frame{Image: img, At: sec}, nil
}

func (f *fakeGrabber) Close() {
	f.mu.Lock()
	f.closed = true
	f.mu.Unlock()
}

// grabbed lists the times Grab was asked for, in order.
func (f *fakeGrabber) grabbed() []float64 {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]float64(nil), f.grabs...)
}

func (f *fakeGrabber) isClosed() bool {
	f.mu.Lock()
	defer f.mu.Unlock()
	return f.closed
}

// serviceWith returns a Service whose Opener hands out f for any source.
func serviceWith(t *testing.T, f *fakeGrabber) *Service {
	t.Helper()
	s := NewService(func(context.Context, streams.Source, string) (Grabber, error) {
		return f, nil
	}, "test")
	t.Cleanup(s.End)
	return s
}

// req is a request for a film of duration seconds on one debrid link.
func req(duration float64) Request {
	return Request{
		Playing:  streams.Source{URL: "https://debrid.example/film.mkv"},
		Duration: duration,
	}
}

// begin starts previews for r, failing the test if Begin refuses it.
func begin(t *testing.T, s *Service, r Request) {
	t.Helper()
	if err := s.Begin(r); err != nil {
		t.Fatalf("Begin: %v", err)
	}
}

func TestAtRoundsDownToTheBucket(t *testing.T) {
	t.Parallel()
	f := &fakeGrabber{duration: 600}
	s := serviceWith(t, f)
	begin(t, s, req(600))

	th, err := s.At(37)
	if err != nil {
		t.Fatalf("At(37): %v", err)
	}
	if th.At != 30 {
		t.Fatalf("At(37) is the thumbnail at %v, want 30", th.At)
	}
	if !strings.HasPrefix(th.URL, "data:image/jpeg;base64,") {
		t.Fatalf("URL is not a JPEG data URL: %.40q", th.URL)
	}
	if th.W != 32 || th.H != 18 {
		t.Fatalf("thumbnail is %d×%d, want 32×18", th.W, th.H)
	}
	if got := f.grabbed(); len(got) != 1 || got[0] != 35 {
		t.Fatalf("Grab got %v, want one Grab(35): the bucket's middle", got)
	}

	// The same bucket, a second time: the cache answers, the decoder doesn't.
	again, err := s.At(31)
	if err != nil {
		t.Fatalf("At(31): %v", err)
	}
	if again != th {
		t.Fatalf("At(31) = %+v, want the cached %+v", again, th)
	}
	if got := f.grabbed(); len(got) != 1 {
		t.Fatalf("Grab got %v, want the one call from At(37)", got)
	}
}

// openerLog opens a fake of its own for each source, remembering which URLs
// were opened and what it made.
type openerLog struct {
	durations map[string]float64

	mu    sync.Mutex
	order []string
	made  map[string]*fakeGrabber
}

func (o *openerLog) open(_ context.Context, src streams.Source, _ string) (Grabber, error) {
	o.mu.Lock()
	defer o.mu.Unlock()
	o.order = append(o.order, src.URL)
	f := &fakeGrabber{duration: o.durations[src.URL]}
	if o.made == nil {
		o.made = map[string]*fakeGrabber{}
	}
	o.made[src.URL] = f
	return f, nil
}

func (o *openerLog) opened() []string {
	o.mu.Lock()
	defer o.mu.Unlock()
	return append([]string(nil), o.order...)
}

func (o *openerLog) grabber(url string) *fakeGrabber {
	o.mu.Lock()
	defer o.mu.Unlock()
	return o.made[url]
}

func TestSmallerCopyIsUsedWhenTheDurationMatches(t *testing.T) {
	t.Parallel()

	t.Run("within the tolerance", func(t *testing.T) {
		o := &openerLog{durations: map[string]float64{
			"https://debrid.example/small.mkv": 7201,
			"https://debrid.example/film.mkv":  7200,
		}}
		s := NewService(o.open, "test")
		t.Cleanup(s.End)
		r := req(7200)
		r.Smaller = []streams.Source{{URL: "https://debrid.example/small.mkv"}}
		begin(t, s, r)

		if _, err := s.At(5); err != nil {
			t.Fatalf("At(5): %v", err)
		}
		if got := o.opened(); len(got) != 1 || got[0] != "https://debrid.example/small.mkv" {
			t.Fatalf("opened %v, want only the smaller copy", got)
		}
		if small := o.grabber("https://debrid.example/small.mkv"); small == nil || small.isClosed() {
			t.Fatal("the smaller copy isn't the open Grabber")
		}
	})

	t.Run("further off than the tolerance", func(t *testing.T) {
		o := &openerLog{durations: map[string]float64{
			"https://debrid.example/small.mkv": 7205,
			"https://debrid.example/film.mkv":  7200,
		}}
		s := NewService(o.open, "test")
		t.Cleanup(s.End)
		r := req(7200)
		r.Smaller = []streams.Source{{URL: "https://debrid.example/small.mkv"}}
		begin(t, s, r)

		if _, err := s.At(5); err != nil {
			t.Fatalf("At(5): %v", err)
		}
		if got := o.opened(); len(got) != 2 || got[1] != "https://debrid.example/film.mkv" {
			t.Fatalf("opened %v, want the smaller copy then the playing file", got)
		}
		if small := o.grabber("https://debrid.example/small.mkv"); !small.isClosed() {
			t.Fatal("the smaller copy is still open after its duration ruled it out")
		}
	})
}

func TestTwoFailuresStopPreviewsForTheFile(t *testing.T) {
	t.Parallel()
	boom := errors.New("boom")
	f := &fakeGrabber{duration: 300, errs: []error{boom, boom}}
	s := serviceWith(t, f)
	begin(t, s, req(300))

	if _, err := s.At(5); !errors.Is(err, boom) {
		t.Fatalf("At(5) = %v, want the Grab's error", err)
	}
	if _, err := s.At(15); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("At(15) = %v, want ErrUnavailable after two failures", err)
	}
	if !f.isClosed() {
		t.Fatal("the Grabber is still open after two failures")
	}
	if _, err := s.At(25); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("At(25) = %v, want ErrUnavailable once stopped", err)
	}
	if got := f.grabbed(); len(got) != 2 {
		t.Fatalf("Grab got %v, want no more after the second failure", got)
	}
}

func TestOneFailureDoesNotStopPreviews(t *testing.T) {
	t.Parallel()
	boom := errors.New("boom")
	f := &fakeGrabber{duration: 300, errs: []error{boom}}
	s := serviceWith(t, f)
	begin(t, s, req(300))

	if _, err := s.At(5); !errors.Is(err, boom) {
		t.Fatalf("At(5) = %v, want the Grab's error", err)
	}
	th, err := s.At(25)
	if err != nil {
		t.Fatalf("At(25): %v", err)
	}
	if th.At != 20 {
		t.Fatalf("At(25) is the thumbnail at %v, want 20", th.At)
	}
}

func TestEndClosesAndForgets(t *testing.T) {
	t.Parallel()
	f := &fakeGrabber{duration: 300}
	s := serviceWith(t, f)
	begin(t, s, req(300))

	if _, err := s.At(5); err != nil {
		t.Fatalf("At(5): %v", err)
	}
	s.End()
	if !f.isClosed() {
		t.Fatal("End left the Grabber open")
	}
	if _, err := s.At(5); !errors.Is(err, ErrUnavailable) {
		t.Fatalf("At(5) after End = %v, want ErrUnavailable", err)
	}
	s.End() // twice is fine, and so is End with nothing begun
}

func TestAtReplacesStaleRequests(t *testing.T) {
	t.Parallel()
	gate, held := make(chan struct{}), make(chan struct{})
	f := &fakeGrabber{duration: 300, gate: gate, held: held}
	s := serviceWith(t, f)
	begin(t, s, req(300))

	type result struct {
		th  Thumb
		err error
	}
	// The first hover's decode: it holds the one Grabber until released.
	first := make(chan result, 1)
	go func() { th, err := s.At(10); first <- result{th, err} }()
	select {
	case <-held:
	case <-time.After(2 * time.Second):
		t.Fatal("the first At never reached Grab")
	}

	// The user drags on: two newer hovers queue behind it.
	mid := make(chan result, 1)
	go func() { th, err := s.At(100); mid <- result{th, err} }()
	time.Sleep(20 * time.Millisecond)
	newest := make(chan result, 1)
	go func() { th, err := s.At(200); newest <- result{th, err} }()
	time.Sleep(20 * time.Millisecond)
	close(gate)

	if r := <-first; r.err != nil {
		t.Fatalf("At(10): %v", r.err)
	}
	if r := <-mid; !errors.Is(r.err, ErrStale) {
		t.Fatalf("At(100) = %v, want ErrStale: At(200) replaced it", r.err)
	}
	r := <-newest
	if r.err != nil {
		t.Fatalf("At(200): %v", r.err)
	}
	if r.th.At != 200 {
		t.Fatalf("At(200) is the thumbnail at %v, want 200", r.th.At)
	}
}

func TestCoarseCoversTheFilmEvenly(t *testing.T) {
	t.Parallel()
	got := coarse(95)

	want := map[float64]bool{}
	for at := 0.0; at < 95; at += BucketSeconds {
		want[at] = true
	}
	if len(got) != len(want) {
		t.Fatalf("coarse(95) lists %d buckets, want %d: %v", len(got), len(want), got)
	}
	seen := map[float64]int{}
	for _, at := range got {
		seen[at]++
	}
	for at := range want {
		if seen[at] != 1 {
			t.Fatalf("bucket %v appears %d times in %v", at, seen[at], got)
		}
	}

	// The spike's order: every 2^k-th first, so the first two thumbnails
	// already show the front and the back of the film.
	if got[0] != 0 || got[1] != 80 {
		t.Fatalf("coarse(95) starts %v, want 0 then 80", got[:2])
	}
	if got[0] >= 95.0/2 || got[1] < 95.0/2 {
		t.Fatalf("the first two buckets (%v) don't cover both halves", got[:2])
	}
}

func TestToneMapBringsPQIntoRange(t *testing.T) {
	t.Parallel()
	img := image.NewNRGBA(image.Rect(0, 0, 4, 4))
	for i := 0; i < len(img.Pix); i += 4 {
		img.Pix[i], img.Pix[i+1], img.Pix[i+2], img.Pix[i+3] = 128, 128, 128, 255
	}

	toneMap(img, "pq", "bt.2020")

	for i := 0; i < len(img.Pix); i += 4 {
		for c := 0; c < 3; c++ {
			if v := img.Pix[i+c]; v < 40 || v > 230 {
				t.Fatalf("pixel %d channel %d is %d, want a visible grey (40…230)", i/4, c, v)
			}
		}
		if a := img.Pix[i+3]; a != 255 {
			t.Fatalf("pixel %d alpha is %d, want 255", i/4, a)
		}
	}
}

func TestFillEmitsThumbnails(t *testing.T) {
	// Not parallel: it shortens the fill's timings for the whole package.
	oldDelay, oldEvery, oldCap := fillDelay, fillEvery, fillCap
	fillDelay, fillEvery, fillCap = time.Millisecond, time.Millisecond, 3
	t.Cleanup(func() { fillDelay, fillEvery, fillCap = oldDelay, oldEvery, oldCap })

	f := &fakeGrabber{duration: 100}
	s := serviceWith(t, f)

	var mu sync.Mutex
	var emitted []Thumb
	names := map[string]int{}
	s.emit = func(name string, data any) {
		mu.Lock()
		defer mu.Unlock()
		names[name]++
		if th, ok := data.(Thumb); ok {
			emitted = append(emitted, th)
		}
	}

	r := req(100)
	r.Fill = true
	begin(t, s, r)

	deadline := time.Now().Add(2 * time.Second)
	for {
		mu.Lock()
		n := len(emitted)
		mu.Unlock()
		if n >= fillCap {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("the fill emitted %d thumbnails in 2 s, want %d", n, fillCap)
		}
		time.Sleep(5 * time.Millisecond)
	}

	mu.Lock()
	defer mu.Unlock()
	if names[EventThumb] != fillCap {
		t.Fatalf("emitted %v, want %d %s events", names, fillCap, EventThumb)
	}
	for _, th := range emitted {
		if th.URL == "" {
			t.Fatalf("emitted a thumbnail at %v with no data URL", th.At)
		}
	}
}
