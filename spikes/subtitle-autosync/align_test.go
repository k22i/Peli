package main

import (
	"math"
	"math/rand/v2"
	"testing"
)

// film makes a plausible dialogue timeline: n cues over ~2 h, gaps 0.3–12 s.
func film(r *rand.Rand, n int) []Cue {
	var out []Cue
	t := int64(60_000)
	for range n {
		t += 300 + r.Int64N(11_700)
		d := 800 + r.Int64N(4_000)
		out = append(out, Cue{Start: t, End: t + d})
		t += d
	}
	return out
}

func starts(c []Cue) []int64 {
	out := make([]int64, len(c))
	for i, x := range c {
		out[i] = x.Start
	}
	return out
}

// release turns the reference into an addon subtitle of another release:
// t = (t_ref - b) / a, with jitter, 15 % of lines dropped (merged lines)
// and 10 % extra (SDH, credits).
func release(r *rand.Rand, ref []Cue, a, b float64, cut func(int64) int64) []int64 {
	var out []int64
	for _, c := range ref {
		if r.Float64() < 0.15 {
			continue
		}
		t := c.Start
		if cut != nil {
			t = cut(t)
		}
		out = append(out, int64((float64(t)-b)/a)+r.Int64N(160)-80)
		if r.Float64() < 0.10 {
			out = append(out, int64((float64(t)-b)/a)+1500+r.Int64N(2000))
		}
	}
	sortInts(out)
	return out
}

func sortInts(x []int64) {
	for i := 1; i < len(x); i++ {
		for j := i; j > 0 && x[j] < x[j-1]; j-- {
			x[j], x[j-1] = x[j-1], x[j]
		}
	}
}

func TestAlignRecoversOffsetAndRate(t *testing.T) {
	cases := []struct {
		name string
		a, b float64
	}{
		{"in sync", 1, 0},
		{"late 2.5 s", 1, 2500},
		{"early 47 s", 1, -47_000},
		{"25 fps sub on 23.976", 25000.0 / 23976, -1200},
		{"1.001 drift", 24000.0 / 23976, 800},
		{"recap 4 min", 1, 240_000},
	}
	for i, c := range cases {
		r := rand.New(rand.NewPCG(uint64(i), 7))
		ref := film(r, 1400)
		tgt := release(r, ref, c.a, c.b, nil)
		al := Align(starts(ref), tgt)
		// residual at a few points along the film
		worst := 0.0
		for _, p := range []int64{tgt[10], tgt[len(tgt)/2], tgt[len(tgt)-10]} {
			want := c.a*float64(p) + c.b - float64(p)
			worst = math.Max(worst, math.Abs(al.Shift(p)-want))
		}
		if worst > 120 || al.Margin < 0.2 {
			t.Errorf("%s: worst residual %.0f ms, %+v", c.name, worst, al)
		}
		if al.Split {
			t.Errorf("%s: false split", c.name)
		}
	}
}

func TestAlignRejectsUnrelated(t *testing.T) {
	r := rand.New(rand.NewPCG(1, 2))
	ref := film(r, 1400)
	other := film(rand.New(rand.NewPCG(9, 9)), 1300)
	al := Align(starts(ref), starts(other))
	if al.Margin > 0.05 || al.Score > 0.4 {
		t.Errorf("unrelated subtitle looks confident: %+v", al)
	}
}

func TestAlignFindsSplit(t *testing.T) {
	r := rand.New(rand.NewPCG(3, 3))
	ref := film(r, 1400)
	// the release has 6 s of extra scene at 60 min: later lines are 6 s later in the ref
	cut := func(t int64) int64 {
		if t > 60*60_000 {
			return t
		}
		return t
	}
	tgt := release(r, ref, 1, 0, cut)
	for i := range tgt {
		if tgt[i] > 60*60_000 {
			tgt[i] -= 6000
		}
	}
	al := Align(starts(ref), tgt)
	if !al.Split {
		t.Fatalf("split not found: %+v", al.Windows)
	}
	late := tgt[len(tgt)-20]
	early := tgt[20]
	if math.Abs(al.PiecewiseShift(late)-al.PiecewiseShift(early)-6000) > 300 {
		t.Errorf("piecewise shift doesn't bridge the cut: early %.0f late %.0f", al.PiecewiseShift(early), al.PiecewiseShift(late))
	}
}
