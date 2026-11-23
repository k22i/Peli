//go:build !ios

package player

import (
	"context"
	"log/slog"
	"time"

	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/store"
)

// Auto-crop finds black bars without FFmpeg's cropdetect, which is GPL and
// not in our LGPL build (#92). Go takes a few frames with screenshot-raw
// (the decoded frame, without subtitles, copied off the GPU once each) and
// finds the rows and columns at the edges that are black. The crop then is
// mpv's video-crop, the renderer's: hardware decoding stays zero-copy.
//
// The schedule, the measuring and the agreement are playback's (the iOS
// engine crops with the same ones); what is here is the desktop's look at
// its own frames.

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
// loads.
func (s *Service) findBars(ctx context.Context, ses *session, file uint64) {
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
		c, ok := playback.DetectBars(img)
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
			slog.Warn("player: auto-crop not set", "error", err)
			continue
		}
		applied = &least
		found := least
		s.update(func(st *State) { st.AutoCrop = &found })
	}
}
