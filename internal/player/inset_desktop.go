//go:build !ios

package player

import (
	"log/slog"
	"strconv"
)

// SetVideoInset shifts the picture left by rightPx CSS pixels, so the docked
// watch party's sidebar doesn't cover it; 0 puts it back. It isn't a party
// control, so the Gate isn't asked. The inset is kept and reapplied when the
// window resizes, a file loads, or the mini player comes or goes (the mini
// player always has none). It needs no session: one that opens later gets it.
func (s *Service) SetVideoInset(rightPx int) error {
	s.mu.Lock()
	s.inset = max(rightPx, 0)
	s.mu.Unlock()
	s.applyInset()
	return nil
}

// applyInset sets mpv's right margin from the inset and the window's width.
func (s *Service) applyInset() {
	ses := s.current()
	if ses == nil {
		return
	}
	s.mu.Lock()
	inset, mini, window := s.inset, s.state.Mini, s.window
	s.mu.Unlock()
	ratio := 0.0
	if window != nil && !mini {
		ratio = insetRatio(inset, window.Width())
	}
	value := strconv.FormatFloat(ratio, 'f', 4, 64)
	if err := ses.m.setProperty("video-margin-ratio-right", value); err != nil {
		slog.Warn("player: video inset not set", "error", err)
	}
}
