package store

import (
	"math"
	"regexp"
	"slices"
	"strconv"
	"strings"
)

// Framing is how the picture fills the window: the fit, the aspect ratio,
// zoom and pan, a crop, rotation and flips. All but the flips are the
// renderer's (no filter); a flip is a lavfi filter, which copies the frame
// off the GPU. A profile has a default fit and auto-crop; a title keeps all
// of it (TitleAdjustments), so an ultrawide film stays cropped.
type Framing struct {
	// Fit is one of FitModes: the whole picture ("fit"), the window filled
	// and the picture cropped ("fill"), stretched to the window, or its own
	// size ("original").
	Fit string `json:"fit"`
	// Aspect overrides the file's: "auto", one of AspectRatios, or "W:H".
	Aspect string `json:"aspect"`
	// Zoom is mpv's video-zoom, log 2: -1 is half the size, 1 twice.
	// PanX and PanY move the picture by its own width and height, -1–1.
	Zoom float64 `json:"zoom"`
	PanX float64 `json:"panX"`
	PanY float64 `json:"panY"`
	// Crop cuts each edge of the picture, in percent of its width or height.
	Crop Crop `json:"crop"`
	// AutoCrop finds black bars and cuts them off (Crop is ignored).
	AutoCrop bool `json:"autoCrop"`
	// Rotate is 0, 90, 180 or 270 degrees, clockwise.
	Rotate int `json:"rotate"`
	// FlipH mirrors the picture, FlipV turns it upside down.
	FlipH bool `json:"flipH"`
	FlipV bool `json:"flipV"`
}

// Crop is how much of each edge to cut, in percent, 0–MaxCrop.
type Crop struct {
	Top    float64 `json:"top"`
	Right  float64 `json:"right"`
	Bottom float64 `json:"bottom"`
	Left   float64 `json:"left"`
}

var (
	FitModes     = []string{"fit", "fill", "stretch", "original"}
	AspectRatios = []string{"16:9", "4:3", "1.85:1", "2.35:1", "2.39:1", "21:9"}
	Rotations    = []int{0, 90, 180, 270}
	// MaxCrop is the most of one edge a crop cuts, in percent.
	MaxCrop = 40.0
	// MinZoom and MaxZoom bound Zoom: a quarter to four times the size.
	MinZoom, MaxZoom = -2.0, 2.0

	customAspect = regexp.MustCompile(`^[0-9]{1,2}(\.[0-9]{1,3})?:[0-9]{1,2}(\.[0-9]{1,3})?$`)
)

// DefaultFraming is the whole picture, as the file has it.
func DefaultFraming() Framing { return Framing{Fit: "fit", Aspect: "auto"} }

// Empty reports whether c cuts nothing.
func (c Crop) Empty() bool { return c == Crop{} }

// Valid reports whether f's choices are known and its numbers in range.
func (f Framing) Valid() bool {
	finite := func(vs ...float64) bool {
		for _, v := range vs {
			if math.IsNaN(v) || math.IsInf(v, 0) {
				return false
			}
		}
		return true
	}
	c := f.Crop
	edges := []float64{c.Top, c.Right, c.Bottom, c.Left}
	if !finite(append(edges, f.Zoom, f.PanX, f.PanY)...) {
		return false
	}
	for _, e := range edges {
		if e < 0 || e > MaxCrop {
			return false
		}
	}
	return slices.Contains(FitModes, f.Fit) &&
		(f.Aspect == "auto" || slices.Contains(AspectRatios, f.Aspect) || validAspect(f.Aspect)) &&
		f.Zoom >= MinZoom && f.Zoom <= MaxZoom && math.Abs(f.PanX) <= 1 && math.Abs(f.PanY) <= 1 &&
		slices.Contains(Rotations, f.Rotate)
}

// validAspect is a "W:H" of two positive numbers.
func validAspect(aspect string) bool {
	if !customAspect.MatchString(aspect) {
		return false
	}
	ws, hs, _ := strings.Cut(aspect, ":")
	w, errW := strconv.ParseFloat(ws, 64)
	h, errH := strconv.ParseFloat(hs, 64)
	return errW == nil && errH == nil && w > 0 && h > 0
}
