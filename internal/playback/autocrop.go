package playback

import (
	"math"
	"time"

	"github.com/k22i/Peli/internal/store"
)

// Auto-crop finds black bars without FFmpeg's cropdetect, which is GPL and
// not in our LGPL build (#92). Go takes a few frames with screenshot-raw
// (the decoded frame, without subtitles, copied off the GPU once each) and
// finds the rows and columns at the edges that are black. The crop then is
// mpv's video-crop, the renderer's: hardware decoding stays zero-copy.
//
// What is here is the pure part, shared by both engines: when to look, what
// a frame's bars are, and how frames of one file agree. Each engine takes
// its own frames and sets its own crop.

// AutoCropAt is when, after a file starts, a frame is looked at: often at
// first, so a film is cropped within seconds, then now and again, in case a
// scene uses more of the frame.
var AutoCropAt = []time.Duration{
	1 * time.Second, 2 * time.Second, 3500 * time.Millisecond, 5 * time.Second,
	7 * time.Second, 10 * time.Second, 15 * time.Second, 20 * time.Second,
	30 * time.Second, 45 * time.Second, 60 * time.Second, 90 * time.Second, 120 * time.Second,
}

const (
	// AutoCropAgree is how many frames must have bars before any crop.
	AutoCropAgree = 3
	// blackLevel is the darkest a pixel's brightest channel gets and still
	// counts as black: video black is 16 in limited range, and compression
	// lifts it a little.
	blackLevel = 26
	// blackShare is the share of a row's or column's pixels that must be
	// black for it to be a bar: a stray bright pixel (a logo's edge, noise)
	// doesn't make it picture.
	blackShare = 0.985
	// minBar is the smallest bar cut, in percent: less is a scan line or two.
	minBar = 0.6
)

// Frame is a screenshot-raw image in bgr0: 4 bytes a pixel.
type Frame struct {
	W, H, Stride int
	Data         []byte
}

// FrameFrom is frame for what the screenshot-raw command answered: an
// mpv_node map of the pixels (data, a byte array) and the frame's size.
func FrameFrom(v any) Frame {
	m, _ := v.(map[string]any)
	data, _ := m["data"].([]byte)
	w, _ := m["w"].(int64)
	h, _ := m["h"].(int64)
	stride, _ := m["stride"].(int64)
	return Frame{W: int(w), H: int(h), Stride: int(stride), Data: data}
}

func (f Frame) dark(x, y int) bool {
	i := y*f.Stride + x*4
	return f.Data[i] <= blackLevel && f.Data[i+1] <= blackLevel && f.Data[i+2] <= blackLevel
}

// DetectBars returns how much of each edge of f is black bar, in percent,
// and false for a frame too dark to tell (a fade, night, credits on black).
func DetectBars(f Frame) (store.Crop, bool) {
	if f.W < 16 || f.H < 16 || len(f.Data) < f.Stride*f.H {
		return store.Crop{}, false
	}
	const step = 4 // every fourth pixel along a line is plenty
	row := func(y int) bool {
		black, n := 0, 0
		for x := 0; x < f.W; x += step {
			n++
			if f.dark(x, y) {
				black++
			}
		}
		return float64(black) >= blackShare*float64(n)
	}
	col := func(x, top, bottom int) bool {
		black, n := 0, 0
		for y := top; y < bottom; y += step {
			n++
			if f.dark(x, y) {
				black++
			}
		}
		return n > 0 && float64(black) >= blackShare*float64(n)
	}
	top := 0
	for top < f.H && row(top) {
		top++
	}
	bottom := 0
	for bottom < f.H-top && row(f.H-1-bottom) {
		bottom++
	}
	left := 0
	for left < f.W && col(left, top, f.H-bottom) {
		left++
	}
	right := 0
	for right < f.W-left && col(f.W-1-right, top, f.H-bottom) {
		right++
	}
	// Mostly black: nothing to tell bars from picture by.
	if float64(f.W-left-right) < 0.3*float64(f.W) || float64(f.H-top-bottom) < 0.3*float64(f.H) {
		return store.Crop{}, false
	}
	pct := func(n, of int) float64 {
		p := float64(n) / float64(of) * 100
		if p < minBar {
			return 0
		}
		return math.Min(math.Floor(p*10)/10, store.MaxCrop)
	}
	return store.Crop{
		Top: pct(top, f.H), Right: pct(right, f.W), Bottom: pct(bottom, f.H), Left: pct(left, f.W),
	}, true
}

// LeastBars is the smallest bar on each edge across crops: a crop that cuts
// no frame's picture.
func LeastBars(crops []store.Crop) store.Crop {
	least := crops[0]
	for _, c := range crops[1:] {
		least.Top = math.Min(least.Top, c.Top)
		least.Right = math.Min(least.Right, c.Right)
		least.Bottom = math.Min(least.Bottom, c.Bottom)
		least.Left = math.Min(least.Left, c.Left)
	}
	return least
}
