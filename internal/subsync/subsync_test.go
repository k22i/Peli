package subsync

import (
	"context"
	"errors"
	"fmt"
	"math"
	"math/rand/v2"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"testing"
)

// film is a plausible dialogue track: n lines over about two hours.
func film(r *rand.Rand, n int) (starts, ends []int64) {
	t := int64(60_000)
	for range n {
		t += 300 + r.Int64N(11_700)
		d := 800 + r.Int64N(4_000)
		starts = append(starts, t)
		ends = append(ends, t+d)
		t += d
	}
	return starts, ends
}

// release is the reference's lines as another release's subtitles time
// them: t = (t_ref − b) / a, jittered, with 15 % of lines gone and 10 %
// more (SDH, credits).
func release(r *rand.Rand, starts, ends []int64, a, b float64) []Line {
	var out []Line
	for i := range starts {
		if r.Float64() < 0.15 {
			continue
		}
		s := int64((float64(starts[i])-b)/a) + r.Int64N(160) - 80
		out = append(out, Line{s, s + ends[i] - starts[i]})
		if r.Float64() < 0.10 {
			out = append(out, Line{s + 1500 + r.Int64N(2000), s + 4000})
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i].Start < out[j].Start })
	return out
}

type Line struct{ Start, End int64 }

func srt(lines []Line) []byte {
	var b strings.Builder
	for i, l := range lines {
		fmt.Fprintf(&b, "%d\r\n%s --> %s\r\nLine %d\r\n\r\n", i+1, clock(l.Start, ",", false), clock(l.End, ",", false), i)
	}
	return []byte(b.String())
}

func TestSyncFixesOffsetsAndFrameRates(t *testing.T) {
	cases := []struct {
		name string
		a, b float64
	}{
		{"late 2.5 s", 1, 2500},
		{"early 47 s", 1, -47_000},
		{"25 fps subtitles on 23.976", 25000.0 / 23976, -1200},
		{"24 vs 23.976 drift", 24000.0 / 23976, 800},
		// The subtitles have a recap the video doesn't.
		{"a 4-minute recap", 1, -240_000},
	}
	for i, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			r := rand.New(rand.NewPCG(uint64(i), 7))
			starts, ends := film(r, 1400)
			ref := &Reference{Tracks: []Track{{Language: "eng", Times: starts}}}
			lines := release(r, starts, ends, c.a, c.b)
			out, res := Sync(ref, srt(lines), "en")
			if res.Status != Synced {
				t.Fatalf("status %s", res.Status)
			}
			got, _ := lineTimes(out)
			for _, k := range []int{5, len(lines) / 2, len(lines) - 5} {
				want := c.a*float64(lines[k].Start) + c.b
				if d := math.Abs(float64(got[k]) - want); d > 120 {
					t.Errorf("line %d off by %.0f ms", k, d)
				}
			}
		})
	}
}

func TestSyncLeavesAnInSyncFile(t *testing.T) {
	r := rand.New(rand.NewPCG(4, 4))
	starts, ends := film(r, 1200)
	ref := &Reference{Tracks: []Track{{Language: "en", Times: starts}}}
	data := srt(release(r, starts, ends, 1, 120))
	out, res := Sync(ref, data, "en")
	if res.Status != InSync || string(out) != string(data) {
		t.Errorf("status %s, changed %v", res.Status, string(out) != string(data))
	}
}

func TestSyncRefusesAnUnrelatedFile(t *testing.T) {
	starts, _ := film(rand.New(rand.NewPCG(1, 2)), 1400)
	other, otherEnds := film(rand.New(rand.NewPCG(9, 9)), 1300)
	ref := &Reference{Tracks: []Track{{Language: "en", Times: starts}}}
	var lines []Line
	for i := range other {
		lines = append(lines, Line{other[i], otherEnds[i]})
	}
	data := srt(lines)
	if out, res := Sync(ref, data, "en"); res.Status != NoMatch || string(out) != string(data) {
		t.Errorf("an unrelated file: %s", res.Status)
	}
}

func TestSyncAgainstPictureSubtitles(t *testing.T) {
	// A PGS track: a packet at each start and each clear.
	r := rand.New(rand.NewPCG(5, 5))
	starts, ends := film(r, 1300)
	packets := append(append([]int64{}, starts...), ends...)
	sort.Slice(packets, func(i, j int) bool { return packets[i] < packets[j] })
	ref := &Reference{Tracks: []Track{{Language: "eng", Picture: true, Times: packets}}}
	_, res := Sync(ref, srt(release(r, starts, ends, 1, -3300)), "en")
	if res.Status != Synced || math.Abs(float64(res.FirstShiftMs+3300)) > 120 {
		t.Errorf("%+v", res)
	}
}

func TestSyncNeedsAReference(t *testing.T) {
	r := rand.New(rand.NewPCG(6, 6))
	starts, ends := film(r, 600)
	data := srt(release(r, starts, ends, 1, 0))
	for _, ref := range []*Reference{nil, {}, {Tracks: []Track{{Language: "en", Forced: true, Times: starts}}}} {
		if _, res := Sync(ref, data, "en"); res.Status != NoReference {
			t.Errorf("%+v: %s", ref, res.Status)
		}
	}
	if _, res := Sync(&Reference{Tracks: []Track{{Times: starts}}}, []byte("not subtitles"), "en"); res.Status != Unchecked {
		t.Errorf("not subtitles: %s", res.Status)
	}
}

func TestReferencesPreferTheLanguage(t *testing.T) {
	times := make([]int64, 400)
	ref := &Reference{Tracks: []Track{
		{Language: "fre", Times: times},
		{Language: "eng", Picture: true, Times: make([]int64, 900)},
		{Language: "en-US", Times: times},
		{Language: "eng", Forced: true, Times: times},
		{Language: "ita", Times: times[:20]},
	}}
	got := references(ref, "en", 400)
	if len(got) != 3 || got[0].Language != "en-US" || !got[1].Picture || got[2].Language != "fre" {
		t.Errorf("%+v", got)
	}
}

func TestRetime(t *testing.T) {
	cases := []struct{ name, in, want string }{
		{"srt", "1\r\n00:00:01,500 --> 00:00:03,000\r\n<i>Hi</i>\r\n\r\n2\r\n01:59:59,900 --> 02:00:01,000\r\nBye\r\n",
			"1\r\n00:00:00,000 --> 00:00:01,000\r\n<i>Hi</i>\r\n\r\n2\r\n01:59:57,900 --> 01:59:59,000\r\nBye\r\n"},
		{"vtt", "WEBVTT\n\n00:10.000 --> 00:12.500 align:start\nHi\n",
			"WEBVTT\n\n00:00:08.000 --> 00:00:10.500 align:start\nHi\n"},
		{"ass", "[Script Info]\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:01:02.50,0:01:04.00,Default,,0,0,0,,{\\an8}Hi\\Nthere\n",
			"[Script Info]\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:01:00.50,0:01:02.00,Default,,0,0,0,,{\\an8}Hi\\Nthere\n"},
	}
	for _, c := range cases {
		if got := string(retime([]byte(c.in), func(int64) int64 { return -2000 })); got != c.want {
			t.Errorf("%s: got %q", c.name, got)
		}
	}
	if starts, ends := lineTimes([]byte(cases[2].in)); len(starts) != 1 || starts[0] != 62_500 || ends[0] != 64_000 {
		t.Errorf("ass times %v %v", starts, ends)
	}
}

func TestLoadMatroska(t *testing.T) {
	const fixture = "../player/testdata/tracks.mkv" // SubRip en, ja, en forced (Signs)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Debrid") != "key" || r.Header.Get("User-Agent") != "Peli/test" {
			http.Error(w, "no", http.StatusForbidden)
			return
		}
		http.ServeFile(w, r, fixture)
	}))
	defer srv.Close()
	for name, src := range map[string]Source{
		"http": {URL: srv.URL + "/f.mkv", Headers: map[string]string{"X-Debrid": "key"}, UserAgent: "Peli/test"},
		"file": {Path: fixture},
	} {
		ref, err := Load(context.Background(), srv.Client(), src)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		var got []string
		for _, tr := range ref.Tracks {
			got = append(got, fmt.Sprintf("%s forced=%v picture=%v has=%v", tr.Language, tr.Forced, tr.Picture, len(tr.Times) > 0))
		}
		want := []string{"eng forced=false picture=false has=true", "jpn forced=false picture=false has=true",
			"eng forced=true picture=false has=true"}
		if fmt.Sprint(got) != fmt.Sprint(want) {
			t.Errorf("%s: tracks %v", name, got)
		}
	}
}

func TestLoadWithoutAReference(t *testing.T) {
	for _, path := range []string{"../player/testdata/clip.mp4"} {
		if _, err := Load(context.Background(), http.DefaultClient, Source{Path: path}); !errors.Is(err, ErrNoReference) {
			t.Errorf("%s: %v", path, err)
		}
	}
	if _, err := Load(context.Background(), http.DefaultClient, Source{URL: "magnet:?xt"}); !errors.Is(err, ErrNoReference) {
		t.Errorf("magnet: %v", err)
	}
	if _, err := os.Stat("../player/testdata/clip.mp4"); err != nil {
		t.Skip("fixture missing")
	}
}

func TestPendingWait(t *testing.T) {
	p := Start(http.DefaultClient, Source{Path: "../player/testdata/tracks.mkv"})
	ref, err := p.Wait(context.Background())
	if err != nil || len(ref.Tracks) == 0 {
		t.Fatalf("%v %v", ref, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	slow := Start(http.DefaultClient, Source{URL: "http://127.0.0.1:9/never"})
	defer slow.Cancel()
	if _, err := slow.Wait(ctx); !errors.Is(err, context.Canceled) {
		t.Errorf("cancelled wait: %v", err)
	}
}
