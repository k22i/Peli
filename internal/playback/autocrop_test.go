package playback

import (
	"testing"

	"github.com/k22i/Peli/internal/store"
)

// letterboxed is a w×h bgr0 frame with black bars of top and bottom rows
// and left and right columns around a mid-grey picture; dark adds a black
// patch at the picture's left edge, as a dark scene has.
func letterboxed(w, h, top, bottom, left, right int, dark bool) Frame {
	f := Frame{W: w, H: h, Stride: w * 4, Data: make([]byte, w*h*4)}
	for y := range h {
		for x := range w {
			in := y >= top && y < h-bottom && x >= left && x < w-right
			if dark && x < left+w/20 {
				in = false
			}
			if in {
				i := y*f.Stride + x*4
				f.Data[i], f.Data[i+1], f.Data[i+2] = 120, 130, 140
			}
		}
	}
	return f
}

func TestDetectBars(t *testing.T) {
	got, ok := DetectBars(letterboxed(400, 300, 38, 38, 0, 0, false))
	if !ok || got.Top != 12.6 || got.Bottom != 12.6 || got.Left != 0 || got.Right != 0 {
		t.Errorf("letterbox: %+v, %v; want 12.6 %% top and bottom", got, ok)
	}
	got, ok = DetectBars(letterboxed(400, 300, 0, 0, 50, 50, false))
	if !ok || got.Left != 12.5 || got.Right != 12.5 || got.Top != 0 {
		t.Errorf("pillarbox: %+v, %v", got, ok)
	}
	// A line or two of black is no bar.
	if got, _ := DetectBars(letterboxed(400, 300, 1, 1, 0, 0, false)); !got.Empty() {
		t.Errorf("a scan line: %+v, want none", got)
	}
	// A fade to black tells nothing.
	if _, ok := DetectBars(letterboxed(400, 300, 140, 140, 0, 0, false)); ok {
		t.Error("a nearly black frame counted")
	}
	// A dark scene reads as more bar; LeastBars keeps the smaller one.
	darkScene, _ := DetectBars(letterboxed(400, 300, 38, 38, 0, 0, true))
	plain, _ := DetectBars(letterboxed(400, 300, 38, 38, 0, 0, false))
	if darkScene.Left <= plain.Left {
		t.Fatalf("dark scene left %v, want more than %v", darkScene.Left, plain.Left)
	}
	if least := LeastBars([]store.Crop{darkScene, plain, darkScene}); least != plain {
		t.Errorf("LeastBars = %+v, want %+v", least, plain)
	}
}

// FrameFrom reads what screenshot-raw answers: a map of the pixels and the
// frame's size, the byte array as Go bytes.
func TestFrameFrom(t *testing.T) {
	data := make([]byte, 16*8*4)
	got := FrameFrom(map[string]any{
		"data": data, "w": int64(16), "h": int64(8), "stride": int64(64),
	})
	if got.W != 16 || got.H != 8 || got.Stride != 64 || len(got.Data) != len(data) {
		t.Errorf("FrameFrom = %+v", got)
	}
	// Anything but a map is an empty frame, not a panic.
	if empty := FrameFrom(nil); empty.W != 0 || empty.H != 0 || empty.Data != nil {
		t.Errorf("FrameFrom(nil) = %+v", empty)
	}
}
