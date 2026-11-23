//go:build ios

package iosplayer

import (
	"github.com/k22i/Peli/internal/playback"
	"github.com/k22i/Peli/internal/streams"
)

// SubtitleSync is how AddSubtitle lined the added track id up with the
// file playing (Subtitle.AutoSync): the zero value for any other track.
func (e *Engine) SubtitleSync(id int) playback.SubtitleSync {
	e.mu.Lock()
	defer e.mu.Unlock()
	return e.synced[id]
}

// startSync starts reading the new file's own subtitle timing, in place of
// the last file's. ops must be held (Load).
func (e *Engine) startSync(source streams.Source) {
	ref := playback.StartSync(e.http, source, e.userAgent)
	e.mu.Lock()
	old := e.syncRef
	e.syncRef, e.synced = ref, nil
	e.mu.Unlock()
	if old != nil {
		old.Cancel()
	}
}

// stopSync stops the read when playback ends.
func (e *Engine) stopSync() {
	e.mu.Lock()
	old := e.syncRef
	e.syncRef, e.synced = nil, nil
	e.mu.Unlock()
	if old != nil {
		old.Cancel()
	}
}
