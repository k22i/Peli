//go:build ios

package iosplayer

import (
	"context"
	"log/slog"
	"time"

	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/safego"
	"github.com/k22i/Peli/internal/store"
)

// Auto-crop on iOS: the desktop's, over this engine's frames. The schedule,
// the measuring and the agreement are playback's (internal/playback/
// autocrop.go); what is here is the look at the file playing and the
// video-crop it ends in.
//
// A frame is taken with screenshot-raw, which copies it off the GPU: w×h×4
// bytes, 8 MB for 1080p and 33 MB for 4K. A phone has less memory to spare
// than an iPad or a Mac, so it leaves a 4K file uncropped rather than risk
// being killed for the frames (autoCropMaxPixels).
const autoCropMaxPixels = 1920 * 1088

// startAutoCrop looks for black bars in the load playing, unless it is
// already. stopAutoCrop stops looking.
func (e *Engine) startAutoCrop(ses *session, load uint64) {
	e.mu.Lock()
	if e.autoCrop != nil && e.autoCropLoad == load {
		e.mu.Unlock()
		return
	}
	if e.autoCrop != nil {
		e.autoCrop()
	}
	ctx, cancel := context.WithCancel(context.Background())
	e.autoCrop, e.autoCropLoad = cancel, load
	e.mu.Unlock()
	safego.Go("iosplayer: auto-crop", func() { e.findBars(ctx, ses, load) })
}

func (e *Engine) stopAutoCrop() {
	e.mu.Lock()
	if e.autoCrop != nil {
		e.autoCrop()
		e.autoCrop = nil
	}
	e.mu.Unlock()
}

// screenshot takes the frame showing, as the decoder made it.
func screenshot(ses *session) (playback.Frame, error) {
	v, err := ses.m.commandResult("screenshot-raw", "video", "bgr0")
	if err != nil {
		return playback.Frame{}, err
	}
	return playback.FrameFrom(v), nil
}

// findBars looks at the file's frames at playback.AutoCropAt and crops the
// bars they agree on, until ctx ends, the session closes or another file
// loads. A frame's bytes are let go as soon as it is measured.
func (e *Engine) findBars(ctx context.Context, ses *session, load uint64) {
	start := time.Now()
	var seen []store.Crop
	var applied *store.Crop
	for _, at := range playback.AutoCropAt {
		select {
		case <-ctx.Done():
			return
		case <-ses.done:
			return
		case <-time.After(time.Until(start.Add(at))):
		}
		e.mu.Lock()
		current, w, h := e.loads == load, e.videoW, e.videoH
		e.mu.Unlock()
		if !current {
			return
		}
		// A phone takes no 4K frame: the memory is better spent on the
		// picture. Says so once, then keeps the picture as it is.
		if Phone() && w*h > autoCropMaxPixels {
			slog.Info("iosplayer: auto-crop skipped", "w", w, "h", h)
			return
		}
		img, err := screenshot(ses)
		if err != nil {
			continue
		}
		c, ok := playback.DetectBars(img)
		img = playback.Frame{}
		if !ok {
			continue
		}
		seen = append(seen, c)
		if len(seen) < playback.AutoCropAgree {
			continue
		}
		least := playback.LeastBars(seen)
		if applied != nil && *applied == least {
			continue
		}
		if ctx.Err() != nil {
			return
		}
		if err := ses.m.setProperty("video-crop", playback.CropProp(least, w, h)); err != nil {
			slog.Warn("iosplayer: auto-crop not set", "error", err)
			continue
		}
		applied = &least
		found := least
		e.update(func(st *playback.State) { st.AutoCrop = &found })
	}
}
