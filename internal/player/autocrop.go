//go:build !ios

package player

import (
	"context"
	"log/slog"
	"math"
	"time"

	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/store"
)

// Auto-crop finds black bars without FFmpeg's cropdetect, which is GPL and
// not in our LGPL build (#92). Go takes a few frames with screenshot-raw
// (the decoded frame, without subtitles, copied off the GPU once each) and
// finds the rows and columns at the edges that are black. The crop then is
// mpv's video-crop, the renderer's: hardware decoding stays zero-copy.

// autoCropAt is when, after a file starts, a frame is looked at: often at
// first, so a film is cropped within seconds, then now and again, in case a
// scene uses more of the frame.
var autoCropAt = []time.Duration{
	1 * time.Second, 2 * time.Second, 3500 * time.Millisecond, 5 * time.Second,
	7 * time.Second, 10 * time.Second, 15 * time.Second, 20 * time.Second,
	30 * time.Second, 45 * time.Second, 60 * time.Second, 90 * time.Second, 120 * time.Second,
}

const (
	// autoCropAgree is how many frames must have bars before any crop.
	autoCropAgree = 3
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

// frame is a screenshot-raw image in bgr0: 4 bytes a pixel.
type frame struct {
	w, h, stride int
	data         []byte
}

func (f frame) dark(x, y int) bool {
	i := y*f.stride + x*4
	return f.data[i] <= blackLevel && f.data[i+1] <= blackLevel && f.data[i+2] <= blackLevel
}

// detectBars returns how much of each edge of f is black bar, in percent,
// and false for a frame too dark to tell (a fade, night, credits on black).
func detectBars(f frame) (store.Crop, bool) {
	if f.w < 16 || f.h < 16 || len(f.data) < f.stride*f.h {
		return store.Crop{}, false
	}
	const step = 4 // every fourth pixel along a line is plenty
	row := func(y int) bool {
		black, n := 0, 0
		for x := 0; x < f.w; x += step {
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
	for top < f.h && row(top) {
		top++
	}
	bottom := 0
	for bottom < f.h-top && row(f.h-1-bottom) {
		bottom++
	}
	left := 0
	for left < f.w && col(left, top, f.h-bottom) {
		left++
	}
	right := 0
	for right < f.w-left && col(f.w-1-right, top, f.h-bottom) {
		right++
	}
	// Mostly black: nothing to tell bars from picture by.
	if float64(f.w-left-right) < 0.3*float64(f.w) || float64(f.h-top-bottom) < 0.3*float64(f.h) {
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
		Top: pct(top, f.h), Right: pct(right, f.w), Bottom: pct(bottom, f.h), Left: pct(left, f.w),
	}, true
}

// leastBars is the smallest bar on each edge across crops: a crop that cuts
// no frame's picture.
func leastBars(crops []store.Crop) store.Crop {
	least := crops[0]
	for _, c := range crops[1:] {
		least.Top = math.Min(least.Top, c.Top)
		least.Right = math.Min(least.Right, c.Right)
		least.Bottom = math.Min(least.Bottom, c.Bottom)
		least.Left = math.Min(least.Left, c.Left)
	}
	return least
}

// screenshot takes the frame showing, as the decoder made it.
func screenshot(ses *session) (frame, error) {
	v, err := ses.m.commandResult("screenshot-raw", "video", "bgr0")
	if err != nil {
		return frame{}, err
	}
	m, _ := v.(map[string]any)
	data, _ := m["data"].([]byte)
	w, _ := m["w"].(int64)
	h, _ := m["h"].(int64)
	stride, _ := m["stride"].(int64)
	return frame{w: int(w), h: int(h), stride: int(stride), data: data}, nil
}

// findBars looks at the file's frames at autoCropAt and crops the bars
// they agree on, until ctx ends, the session closes or another file loads.
func (s *Service) findBars(ctx context.Context, ses *session, file uint64) {
	start := time.Now()
	var seen []store.Crop
	var applied *store.Crop
	for _, at := range autoCropAt {
		select {
		case <-ctx.Done():
			return
		case <-ses.done:
			return
		case <-time.After(time.Until(start.Add(at))):
		}
		s.mu.Lock()
		current, w, h := s.file == file, s.videoW, s.videoH
		s.mu.Unlock()
		if !current {
			return
		}
		img, err := screenshot(ses)
		if err != nil {
			continue
		}
		c, ok := detectBars(img)
		if !ok {
			continue
		}
		seen = append(seen, c)
		if len(seen) < autoCropAgree {
			continue
		}
		least := leastBars(seen)
		if applied != nil && *applied == least {
			continue
		}
		if ctx.Err() != nil {
			return
		}
		if err := ses.m.setProperty("video-crop", playback.CropProp(least, w, h)); err != nil {
			slog.Warn("player: auto-crop not set", "error", err)
			continue
		}
		applied = &least
		found := least
		s.update(func(st *State) { st.AutoCrop = &found })
	}
}
