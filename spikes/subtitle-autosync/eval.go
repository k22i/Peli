package main

import (
	"fmt"
	"math"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Truth is the real offset at up to three points of the film, found by
// matching the embedded subtitle's words to the candidate's words. It's
// independent of the aligner, which never sees text.
type TruthWindow struct {
	AtMs     int64 `json:"at_ms"`     // candidate time
	OffsetMs int64 `json:"offset_ms"` // add this to the candidate to match the video
	Matches  int   `json:"matches"`
}

type Pair struct {
	Key      string `json:"key"`
	Sub      string `json:"sub"`
	Lang     string `json:"lang"`
	FPS      int    `json:"fps"`
	SubCues  int    `json:"sub_cues"`
	RefTrack string `json:"ref_track"` // lang/codec of the reference used
	RefKind  string `json:"ref_kind"`  // text, picture
	SameLang bool   `json:"same_lang"`
	Align    Alignment     `json:"align"`
	AlignMs  float64       `json:"align_ms"`
	Truth    []TruthWindow `json:"truth,omitempty"`
}

// error before and after, at the truth windows (ms, worst window)
func (p *Pair) errors(piecewise bool) (before, after float64, ok bool) {
	if len(p.Truth) < 2 {
		return 0, 0, false
	}
	for _, w := range p.Truth {
		before = math.Max(before, math.Abs(float64(w.OffsetMs)))
		s := p.Align.Shift(w.AtMs)
		if piecewise {
			s = p.Align.PiecewiseShift(w.AtMs)
		}
		after = math.Max(after, math.Abs(float64(w.OffsetMs)-s))
	}
	return before, after, true
}

const syncedMs = 300.0 // a line within 300 ms of the speech reads as in sync

type Reason struct {
	Key, Why string
}

func cmdEval() error {
	c, err := loadCorpus("")
	if err != nil {
		return err
	}
	var pairs []Pair
	var noRef []Reason
	for _, e := range c {
		var ref RefFile
		if err := readJSON(filepath.Join("results/refs", e.Key+".json"), &ref); err != nil {
			continue
		}
		refs, why := referenceTracks(ref)
		if len(refs) == 0 {
			noRef = append(noRef, Reason{e.Key, why})
			continue
		}
		var subs SubList
		readJSON(filepath.Join("results/refs", e.Key+".subs.json"), &subs)
		var truth []TruthCue
		readJSON(filepath.Join(cacheDir, "truth-"+e.Key+".json"), &truth)
		for _, s := range subs.Subs {
			data, err := os.ReadFile(filepath.Join(cacheDir, "sub-"+s.ID))
			if err != nil {
				continue
			}
			cues := ParseSubtitle(data)
			if len(cues) < 50 {
				continue
			}
			p := Pair{Key: e.Key, Sub: s.ID, Lang: s.Lang, FPS: s.FPS, SubCues: len(cues)}
			start := time.Now()
			best := -1.0
			for _, t := range refs {
				tgt := targetPoints(cues, t.Picture())
				al := Align(t.Times, tgt)
				if q := al.Score + al.Margin; q > best {
					best = q
					p.Align = al
					p.RefTrack = t.Language + " " + strings.TrimPrefix(t.Codec, "S_")
					p.RefKind = map[bool]string{true: "picture", false: "text"}[t.Picture()]
					p.SameLang = sameLang(t.Language, s.Lang)
				}
			}
			p.AlignMs = float64(time.Since(start).Microseconds()) / 1000
			if len(truth) > 0 && s.Lang == "eng" {
				p.Truth = truthWindows(truth, cues)
			}
			pairs = append(pairs, p)
		}
	}
	if err := writeJSON("results/pairs.json", pairs); err != nil {
		return err
	}
	report(c, pairs, noRef)
	return nil
}

func sameLang(mkv, os3 string) bool {
	m := map[string]string{"eng": "en", "spa": "es", "fre": "fr"}
	return strings.HasPrefix(mkv, m[os3]) || mkv == os3 || (os3 == "fre" && mkv == "fra")
}

// referenceTracks: full (not forced) subtitle tracks with enough indexed
// packets, best first; at most one per language and kind.
func referenceTracks(ref RefFile) ([]*RefTrack, string) {
	switch {
	case ref.Error != "":
		return nil, "error: " + ref.Error
	case ref.Container == "mp4":
		return nil, "mp4 (not indexed in the spike): " + strings.Join(ref.MP4Subs, ",")
	case len(ref.Tracks) == 0:
		return nil, "no subtitle tracks"
	}
	var out []*RefTrack
	seen := map[string]bool{}
	forcedOnly, unindexed := true, true
	for i := range ref.Tracks {
		t := &ref.Tracks[i]
		if !t.Forced {
			forcedOnly = false
		}
		if t.CueCount > 0 {
			unindexed = false
		}
		k := t.Language + fmt.Sprint(t.Picture())
		if t.Forced || t.CueCount < 100 || seen[k] {
			continue
		}
		seen[k] = true
		out = append(out, t)
	}
	sort.SliceStable(out, func(i, j int) bool { return out[i].CueCount > out[j].CueCount })
	if len(out) > 4 {
		out = out[:4]
	}
	why := "only short tracks"
	switch {
	case forcedOnly:
		why = "forced tracks only"
	case unindexed:
		why = "subtitles not in Cues"
	}
	return out, why
}

// targetPoints: line starts; for a picture reference (PGS packets mark
// both the start and the clear of each line) the ends too.
func targetPoints(cues []Cue, picture bool) []int64 {
	var out []int64
	for _, c := range cues {
		out = append(out, c.Start)
		if picture {
			out = append(out, c.End)
		}
	}
	sort.Slice(out, func(i, j int) bool { return out[i] < out[j] })
	return out
}

func truthWindows(truth []TruthCue, cues []Cue) []TruthWindow {
	// group the 3 × 12 lines into windows by gaps over 5 min
	var groups [][]TruthCue
	for i, t := range truth {
		if i == 0 || t.Ms-truth[i-1].Ms > 5*60_000 {
			groups = append(groups, nil)
		}
		groups[len(groups)-1] = append(groups[len(groups)-1], t)
	}
	cw := make([][]string, len(cues))
	for i, c := range cues {
		cw[i] = words(c.Text)
	}
	var out []TruthWindow
	for _, g := range groups {
		type m struct{ at, off int64 }
		var ms []m
		for _, t := range g {
			tw := words(t.Text)
			if len(tw) < 3 {
				continue
			}
			bi, bs := -1, 0.0
			for i := range cues {
				if s := similarity(tw, cw[i]); s > bs {
					bi, bs = i, s
				}
			}
			if bs >= 0.7 {
				ms = append(ms, m{cues[bi].Start, t.Ms - cues[bi].Start})
			}
		}
		if len(ms) < 3 {
			continue
		}
		offs := make([]int64, len(ms))
		for i, x := range ms {
			offs[i] = x.off
		}
		med := median(offs)
		var in []m
		for _, x := range ms {
			if abs64(x.off-med) <= 400 {
				in = append(in, x)
			}
		}
		if len(in) < 3 || len(in)*2 < len(ms) {
			continue
		}
		var ats, os []int64
		for _, x := range in {
			ats = append(ats, x.at)
			os = append(os, x.off)
		}
		out = append(out, TruthWindow{AtMs: median(ats), OffsetMs: median(os), Matches: len(in)})
	}
	return out
}

func similarity(a, b []string) float64 {
	if len(a) == 0 || len(b) == 0 {
		return 0
	}
	set := map[string]int{}
	for _, w := range b {
		set[w]++
	}
	n := 0
	for _, w := range a {
		if set[w] > 0 {
			set[w]--
			n++
		}
	}
	return float64(n) / float64(max(len(a), len(b)))
}

func median(x []int64) int64 {
	y := append([]int64(nil), x...)
	sort.Slice(y, func(i, j int) bool { return y[i] < y[j] })
	return y[len(y)/2]
}

func abs64(x int64) int64 {
	if x < 0 {
		return -x
	}
	return x
}

// Policy: apply when the aligner is confident and the shift is more than
// the tolerance somewhere.
type Policy struct {
	MinScore, MinMargin float64
	Piecewise           bool
}

func (p Policy) applies(a Alignment, first, last int64) bool {
	if a.Score < p.MinScore || a.Margin < p.MinMargin {
		return false
	}
	return math.Abs(a.Shift(first)) > syncedMs || math.Abs(a.Shift(last)) > syncedMs || (p.Piecewise && a.Split)
}

type Outcome struct {
	Fixed, Kept, Harmed, Wrong, Missed, Leftalone int
}

func evalPolicy(pairs []Pair, pol Policy) Outcome {
	var o Outcome
	for i := range pairs {
		p := &pairs[i]
		before, after, ok := p.errors(pol.Piecewise)
		if !ok {
			continue
		}
		first, last := p.Truth[0].AtMs, p.Truth[len(p.Truth)-1].AtMs
		apply := pol.applies(p.Align, first, last)
		switch {
		case !apply && before <= syncedMs:
			o.Kept++
		case !apply:
			o.Missed++
		case before <= syncedMs && after <= syncedMs:
			o.Kept++
		case before <= syncedMs:
			o.Harmed++
		case after <= syncedMs:
			o.Fixed++
		default:
			o.Wrong++
		}
	}
	return o
}

func report(c []Entry, pairs []Pair, noRef []Reason) {
	fmt.Printf("\n%d releases, %d with a reference, %d pairs\n", len(c), len(c)-len(noRef), len(pairs))
	for _, r := range noRef {
		fmt.Printf("  no reference: %-24s %s\n", r.Key, r.Why)
	}
	withTruth := 0
	var offBy []float64
	for i := range pairs {
		if b, _, ok := pairs[i].errors(false); ok {
			withTruth++
			offBy = append(offBy, b)
		}
	}
	sort.Float64s(offBy)
	buckets := []float64{300, 1000, 3000, 10000, math.Inf(1)}
	counts := make([]int, len(buckets))
	for _, b := range offBy {
		for i, lim := range buckets {
			if b <= lim {
				counts[i]++
				break
			}
		}
	}
	fmt.Printf("\npairs with truth: %d; worst offset before: ≤0.3 s %d, ≤1 s %d, ≤3 s %d, ≤10 s %d, more %d\n",
		withTruth, counts[0], counts[1], counts[2], counts[3], counts[4])
	fmt.Println("\npolicy (score, margin, piecewise) → fixed kept harmed wrong missed")
	for _, pw := range []bool{false, true} {
		for _, s := range []float64{0.3, 0.4, 0.5, 0.6} {
			for _, m := range []float64{0.03, 0.05, 0.1, 0.15, 0.2} {
				o := evalPolicy(pairs, Policy{s, m, pw})
				fmt.Printf("  %.1f %.2f %-5v → %3d %3d %3d %3d %3d\n", s, m, pw, o.Fixed, o.Kept, o.Harmed, o.Wrong, o.Missed)
			}
		}
	}
	var t []float64
	for _, p := range pairs {
		t = append(t, p.AlignMs)
	}
	sort.Float64s(t)
	if len(t) > 0 {
		fmt.Printf("\nalign time per pair: median %.1f ms, p95 %.1f ms, max %.1f ms\n", t[len(t)/2], t[len(t)*95/100], t[len(t)-1])
	}
}
