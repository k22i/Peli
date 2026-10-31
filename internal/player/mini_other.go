//go:build !darwin

package player

import (
	"math"
	"sync"

	"github.com/wailsapp/wails/v3/pkg/application"
)

const miniWidth, miniMargin = 480, 16

// The window as it was before the mini player, to put back, and where the
// user last left the mini player in this run.
var (
	miniMu    sync.Mutex
	fullFrame application.Rect
	miniFrame application.Rect
	miniMoved bool
)

// setMini makes window the mini player, or the app window again, with
// Wails' window calls: small, on top of other windows, in the bottom right
// corner of its screen's work area. Unlike macOS, the window doesn't keep
// the video's shape when resized.
func setMini(window *application.WebviewWindow, on bool, aspect float64) error {
	miniMu.Lock()
	defer miniMu.Unlock()
	if !on {
		miniFrame, miniMoved = window.Bounds(), true
		window.SetAlwaysOnTop(false)
		window.SetBounds(fullFrame)
		return nil
	}
	if !(aspect > 0) {
		aspect = 16.0 / 9
	}
	screen, err := window.GetScreen()
	if err != nil {
		return err
	}
	fullFrame = window.Bounds()
	work := screen.WorkArea
	width := min(miniWidth, work.Width/3)
	if miniMoved && inside(miniFrame, work) {
		width = miniFrame.Width
	}
	height := int(math.Round(float64(width) / aspect))
	frame := application.Rect{
		X: work.X + work.Width - width - miniMargin, Y: work.Y + work.Height - height - miniMargin,
		Width: width, Height: height,
	}
	if miniMoved && inside(miniFrame, work) {
		frame.X, frame.Y = miniFrame.X, miniFrame.Y
	}
	window.SetAlwaysOnTop(true)
	window.SetBounds(frame)
	return nil
}

func inside(r, in application.Rect) bool {
	return r.X >= in.X && r.Y >= in.Y && r.X+r.Width <= in.X+in.Width && r.Y+r.Height <= in.Y+in.Height
}
