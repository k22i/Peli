package main

import (
	"math"
	"sort"
)

// Text-free alignment of a candidate subtitle's timing to a reference
// timeline (the embedded subtitle packet times from Cues). The model is
// t' = a·t + b: b is the offset, a the frame-rate ratio (25 vs 23.976 fps
// releases, or 1.001 for 24 vs 23.976). Windows then look for local
// offsets that differ from the global one (a cut or an extra scene).

// Frame-rate ratios worth trying. 1.001 drifts 7 s over two hours.
var scales = []float64{
	1,
	24000.0 / 23976, 23976.0 / 24000,
	25000.0 / 23976, 23976.0 / 25000,
	25.0 / 24, 24.0 / 25,
}

const (
	maxOffsetMs  = 300_000 // ±5 min
	binMs        = 100
	matchTolMs   = 300.0
	distinctMs   = 1_000.0 // two transforms this far apart anywhere are rivals
	windowMs     = 8 * 60_000
	windowMinPts = 12
	windowRadius = 20_000
)

type Window struct {
	AtMs     int64   `json:"at_ms"`     // window centre, candidate time
	OffsetMs int64   `json:"offset_ms"` // local best offset minus the global shift there
	Score    float64 `json:"score"`
	Points   int     `json:"points"`
}

type Alignment struct {
	Scale    float64  `json:"scale"`
	OffsetMs float64  `json:"offset_ms"`
	Score    float64  `json:"score"`  // matched share of candidate points, 0–1
	Second   float64  `json:"second"` // best rival transform's score
	Margin   float64  `json:"margin"`
	Baseline float64  `json:"baseline"` // score at the identity transform
	Points   int      `json:"points"`
	RefPts   int      `json:"ref_points"`
	Windows  []Window `json:"windows,omitempty"`
	// Split: some windows agree on a local offset ≥ 600 ms off the global one.
	Split bool `json:"split"`
}

// Shift is the correction at candidate time t (ms to add), global model only.
func (a *Alignment) Shift(t int64) float64 {
	return a.Scale*float64(t) + a.OffsetMs - float64(t)
}

// PiecewiseShift adds the local window offset where a window is confident.
func (a *Alignment) PiecewiseShift(t int64) float64 {
	base := a.Shift(t)
	if !a.Split {
		return base
	}
	best, bestD := Window{}, int64(math.MaxInt64)
	for _, w := range a.Windows {
		d := w.AtMs - t
		if d < 0 {
			d = -d
		}
		if d < bestD && w.Score >= 0.5 {
			best, bestD = w, d
		}
	}
	if bestD <= windowMs {
		return base + float64(best.OffsetMs)
	}
	return base
}

func nearest(ref []int64, q float64) float64 {
	i := sort.Search(len(ref), func(i int) bool { return float64(ref[i]) >= q })
	d := math.Inf(1)
	if i < len(ref) {
		d = float64(ref[i]) - q
	}
	if i > 0 {
		if e := q - float64(ref[i-1]); e < math.Abs(d) {
			d = -e
		}
	}
	return d
}

// score is the matched share of the candidate points under t' = a·t + b.
// Points mapped outside the reference's span count against it only up to
// 40 %, so a partial subtitle (one CD of two) can still match.
func score(ref, tgt []int64, a, b float64) float64 {
	if len(ref) == 0 || len(tgt) == 0 {
		return 0
	}
	lo, hi := float64(ref[0])-5000, float64(ref[len(ref)-1])+5000
	var sum float64
	in := 0
	for _, p := range tgt {
		q := a*float64(p) + b
		if q < lo || q > hi {
			continue
		}
		in++
		if d := math.Abs(nearest(ref, q)); d < matchTolMs {
			sum += 1 - d/matchTolMs
		}
	}
	den := math.Max(float64(in), 0.6*float64(len(tgt)))
	return sum / den
}

type cand struct{ a, b, s float64 }

// Align finds the transform that best maps tgt onto ref.
func Align(ref, tgt []int64) Alignment {
	out := Alignment{Points: len(tgt), RefPts: len(ref), Scale: 1}
	if len(ref) < 8 || len(tgt) < 8 {
		return out
	}
	out.Baseline = score(ref, tgt, 1, 0)
	nb := 2*maxOffsetMs/binMs + 1
	var cands []cand
	for _, a := range scales {
		hist := make([]float64, nb)
		for _, p := range tgt {
			q := a * float64(p)
			lo := sort.Search(len(ref), func(i int) bool { return float64(ref[i]) >= q-maxOffsetMs })
			for j := lo; j < len(ref) && float64(ref[j]) <= q+maxOffsetMs; j++ {
				bin := int(math.Round((float64(ref[j]) - q + maxOffsetMs) / binMs))
				if bin >= 0 && bin < nb {
					hist[bin]++
				}
			}
		}
		// ±2 bins smoothing, then the top 3 peaks at least 3 s apart.
		sm := make([]float64, nb)
		for i := range hist {
			for k := -2; k <= 2; k++ {
				if j := i + k; j >= 0 && j < nb {
					sm[i] += hist[j]
				}
			}
		}
		used := make([]bool, nb)
		for range 3 {
			best := -1
			for i, v := range sm {
				if !used[i] && (best < 0 || v > sm[best]) {
					best = i
				}
			}
			if best < 0 {
				break
			}
			for k := -30; k <= 30; k++ {
				if j := best + k; j >= 0 && j < nb {
					used[j] = true
				}
			}
			b := float64(best*binMs - maxOffsetMs)
			cands = append(cands, refine(ref, tgt, a, b))
		}
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].s > cands[j].s })
	best := cands[0]
	// Least-squares on the matched pairs: catches drift between the scales
	// tried (a 1.0005 encode, say).
	if fit, ok := fitPairs(ref, tgt, best.a, best.b); ok {
		if s := score(ref, tgt, fit.a, fit.b); s > best.s+0.005 {
			best = cand{fit.a, fit.b, s}
		}
	}
	out.Scale, out.OffsetMs, out.Score = best.a, best.b, best.s
	first, last := float64(tgt[0]), float64(tgt[len(tgt)-1])
	for _, c := range cands[1:] {
		d0 := math.Abs((c.a*first + c.b) - (best.a*first + best.b))
		d1 := math.Abs((c.a*last + c.b) - (best.a*last + best.b))
		if math.Max(d0, d1) > distinctMs && c.s > out.Second {
			out.Second = c.s
		}
	}
	out.Margin = out.Score - out.Second
	out.Windows, out.Split = windows(ref, tgt, best.a, best.b)
	return out
}

// refine searches b ± 500 ms at 10 ms.
func refine(ref, tgt []int64, a, b float64) cand {
	best := cand{a, b, score(ref, tgt, a, b)}
	for d := -500.0; d <= 500; d += 10 {
		if s := score(ref, tgt, a, b+d); s > best.s {
			best = cand{a, b + d, s}
		}
	}
	return best
}

func fitPairs(ref, tgt []int64, a, b float64) (cand, bool) {
	var n, sx, sy, sxx, sxy float64
	for _, p := range tgt {
		q := a*float64(p) + b
		d := nearest(ref, q)
		if math.Abs(d) > 200 {
			continue
		}
		x, y := float64(p), q+d
		n++
		sx += x
		sy += y
		sxx += x * x
		sxy += x * y
	}
	if n < 20 {
		return cand{}, false
	}
	den := n*sxx - sx*sx
	if den == 0 {
		return cand{}, false
	}
	fa := (n*sxy - sx*sy) / den
	fb := (sy - fa*sx) / n
	if fa < 0.94 || fa > 1.06 {
		return cand{}, false
	}
	return cand{fa, fb, 0}, true
}

// windows finds the local offset in each 8-minute stretch of the candidate.
func windows(ref, tgt []int64, a, b float64) ([]Window, bool) {
	var out []Window
	first, last := tgt[0], tgt[len(tgt)-1]
	for start := first; start < last; start += windowMs {
		var pts []int64
		for _, p := range tgt {
			if p >= start && p < start+windowMs {
				pts = append(pts, p)
			}
		}
		if len(pts) < windowMinPts {
			continue
		}
		w := Window{AtMs: start + windowMs/2, Points: len(pts), Score: -1}
		for d := -float64(windowRadius); d <= windowRadius; d += 20 {
			if s := windowScore(ref, pts, a, b+d); s > w.Score+1e-9 ||
				(math.Abs(s-w.Score) < 1e-9 && math.Abs(d) < math.Abs(float64(w.OffsetMs))) {
				w.Score, w.OffsetMs = s, int64(d)
			}
		}
		out = append(out, w)
	}
	// A split: two or more confident windows agree on being ≥ 600 ms off.
	off := 0
	for _, w := range out {
		if w.Score >= 0.5 && math.Abs(float64(w.OffsetMs)) >= 600 {
			off++
		}
	}
	return out, off >= 2
}

func windowScore(ref, pts []int64, a, b float64) float64 {
	var sum float64
	for _, p := range pts {
		if d := math.Abs(nearest(ref, a*float64(p)+b)); d < matchTolMs {
			sum += 1 - d/matchTolMs
		}
	}
	return sum / float64(len(pts))
}
