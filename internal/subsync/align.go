package subsync

import (
	"math"
	"sort"
)

// Aligning a candidate's line times to a reference's packet times, with no
// text: the model is t' = scale·t + offset. The scale covers a subtitle
// made for another frame rate (25 vs 23.976 fps, or 24 vs 23.976, which
// drifts 7 s over two hours). Tuned on 137 measured pairs
// (docs/spikes/subtitle-autosync.md).

var scales = []float64{
	1,
	24000.0 / 23976, 23976.0 / 24000,
	25000.0 / 23976, 23976.0 / 25000,
	25.0 / 24, 24.0 / 25,
}

const (
	maxOffsetMs = 300_000 // ±5 min: a recap or an intro another release lacks
	binMs       = 100
	matchMs     = 300.0 // a point this close to a reference packet matches
	rivalMs     = 1_000.0
	peaks       = 3 // offsets tried per scale

	// The gate: a fit is applied when it matches this share of the
	// candidate's points and beats the best rival transform by this much.
	// At 0.4 / 0.05 the spike fixed 58 of 89 out-of-sync files and moved
	// none that was in sync.
	minScore  = 0.4
	minMargin = 0.05
	// Within this everywhere, the file is left as it was.
	toleranceMs = 300.0
)

type fit struct {
	scale, offset, score float64
}

// shiftAt is what the fit adds at candidate time t.
func (f fit) shiftAt(t int64) float64 {
	return f.scale*float64(t) + f.offset - float64(t)
}

type alignment struct {
	fit
	margin float64
}

// nearest is the signed distance from q to the closest reference time.
func nearest(ref []int64, q float64) float64 {
	i := sort.Search(len(ref), func(i int) bool { return float64(ref[i]) >= q })
	d := math.Inf(1)
	if i < len(ref) {
		d = float64(ref[i]) - q
	}
	if i > 0 && q-float64(ref[i-1]) < math.Abs(d) {
		d = float64(ref[i-1]) - q
	}
	return d
}

// score is the matched share of the candidate's points under a·t + b,
// closer matches counting more. Points mapped outside the reference count
// against it only up to 40 % of them, so a part of a film (one CD of two)
// still fits.
func score(ref, pts []int64, a, b float64) float64 {
	lo, hi := float64(ref[0])-5000, float64(ref[len(ref)-1])+5000
	var sum float64
	in := 0
	for _, p := range pts {
		q := a*float64(p) + b
		if q < lo || q > hi {
			continue
		}
		in++
		if d := math.Abs(nearest(ref, q)); d < matchMs {
			sum += 1 - d/matchMs
		}
	}
	return sum / math.Max(float64(in), 0.6*float64(len(pts)))
}

// align finds the transform that best maps pts onto ref.
func align(ref, pts []int64) (alignment, bool) {
	if len(ref) < 8 || len(pts) < 8 {
		return alignment{}, false
	}
	bins := 2*maxOffsetMs/binMs + 1
	hist := make([]float64, bins)
	smooth := make([]float64, bins)
	used := make([]bool, bins)
	var cands []fit
	for _, a := range scales {
		clear(hist)
		clear(smooth)
		clear(used)
		// Every (candidate, reference) pair within reach votes for the
		// offset between them.
		for _, p := range pts {
			q := a * float64(p)
			j := sort.Search(len(ref), func(i int) bool { return float64(ref[i]) >= q-maxOffsetMs })
			for ; j < len(ref) && float64(ref[j]) <= q+maxOffsetMs; j++ {
				if bin := int(math.Round((float64(ref[j]) - q + maxOffsetMs) / binMs)); bin >= 0 && bin < bins {
					hist[bin]++
				}
			}
		}
		for i := range hist {
			for k := max(i-2, 0); k <= min(i+2, bins-1); k++ {
				smooth[i] += hist[k]
			}
		}
		for range peaks {
			best := -1
			for i, v := range smooth {
				if !used[i] && (best < 0 || v > smooth[best]) {
					best = i
				}
			}
			if best < 0 {
				break
			}
			// Peaks at least 3 s apart.
			for k := max(best-30, 0); k <= min(best+30, bins-1); k++ {
				used[k] = true
			}
			cands = append(cands, refine(ref, pts, a, float64(best*binMs-maxOffsetMs)))
		}
	}
	sort.Slice(cands, func(i, j int) bool { return cands[i].score > cands[j].score })
	best := cands[0]
	// Least squares on the matched pairs: drift between the scales tried.
	if f, ok := leastSquares(ref, pts, best); ok {
		if s := score(ref, pts, f.scale, f.offset); s > best.score+0.005 {
			best = fit{f.scale, f.offset, s}
		}
	}
	// The best rival: a transform that puts some line at least 1 s away.
	first, last := pts[0], pts[len(pts)-1]
	second := 0.0
	for _, c := range cands {
		apart := math.Max(math.Abs(c.shiftAt(first)-best.shiftAt(first)),
			math.Abs(c.shiftAt(last)-best.shiftAt(last)))
		if apart > rivalMs && c.score > second {
			second = c.score
		}
	}
	return alignment{fit: best, margin: best.score - second}, true
}

// refine searches b ± 500 ms: by 50 ms, then by 10 ms around the best.
func refine(ref, pts []int64, a, b float64) fit {
	best := fit{a, b, score(ref, pts, a, b)}
	for d := -500.0; d <= 500; d += 50 {
		if s := score(ref, pts, a, b+d); s > best.score {
			best = fit{a, b + d, s}
		}
	}
	center := best.offset
	for d := -40.0; d <= 40; d += 10 {
		if s := score(ref, pts, a, center+d); s > best.score {
			best = fit{a, center + d, s}
		}
	}
	return best
}

func leastSquares(ref, pts []int64, f fit) (fit, bool) {
	var n, sx, sy, sxx, sxy float64
	for _, p := range pts {
		q := f.scale*float64(p) + f.offset
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
		return fit{}, false
	}
	den := n*sxx - sx*sx
	if den == 0 {
		return fit{}, false
	}
	a := (n*sxy - sx*sy) / den
	if a < 0.94 || a > 1.06 {
		return fit{}, false
	}
	return fit{scale: a, offset: (sy - a*sx) / n}, true
}
