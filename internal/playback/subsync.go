package playback

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/k22i/Peli/internal/streams"
	"github.com/k22i/Peli/internal/subsync"
)

// SubtitleSync is how an addon subtitle file was lined up with the video
// (Subtitle.AutoSync): Status is "synced" (it was off and was moved),
// "inSync" (it fitted already), "noMatch" (no confident fit: left as it
// was), "noReference" (the video has no subtitles of its own to compare
// with), "unchecked" (not tried, or the video's weren't read in time), or
// "" for a track that isn't an addon's. FirstShift and LastShift are how
// far its first and last lines moved, in seconds (later is positive); they
// differ when a frame-rate difference was corrected.
type SubtitleSync struct {
	Status     string  `json:"status"`
	FirstShift float64 `json:"firstShift"`
	LastShift  float64 `json:"lastShift"`
}

// SyncWait caps how long AddSubtitle waits for the video's own subtitle
// timing, read since the file loaded (a few seconds over a debrid CDN).
const SyncWait = 6 * time.Second

// StartSync starts reading the reference of the file source plays (its
// subtitles' timing), with the headers and user agent mpv gets. Every
// file has its own; a download's is read from the disk.
func StartSync(client *http.Client, source streams.Source, userAgent string) *subsync.Pending {
	src := subsync.Source{URL: source.URL, Headers: source.Headers, UserAgent: source.UserAgent}
	if src.UserAgent == "" {
		src.UserAgent = userAgent
	}
	if strings.HasPrefix(source.Origin, "download:") {
		src = subsync.Source{Path: source.URL}
	}
	return subsync.Start(client, src)
}

// SyncSubtitle lines data (an addon's subtitle file in language lang) up
// with the reference p reads, waiting up to SyncWait for it. It returns
// the file to add: retimed, or as it was.
func SyncSubtitle(ctx context.Context, p *subsync.Pending, data []byte, lang string) ([]byte, SubtitleSync) {
	if p == nil {
		return data, SubtitleSync{Status: string(subsync.Unchecked)}
	}
	ctx, cancel := context.WithTimeout(ctx, SyncWait)
	defer cancel()
	ref, err := p.Wait(ctx)
	switch {
	case errors.Is(err, subsync.ErrNoReference):
		return data, SubtitleSync{Status: string(subsync.NoReference)}
	case err != nil:
		// Not read in time, or the read failed (the network, a CDN).
		return data, SubtitleSync{Status: string(subsync.Unchecked)}
	}
	out, res := subsync.Sync(ref, data, lang)
	return out, SubtitleSync{
		Status:     string(res.Status),
		FirstShift: float64(res.FirstShiftMs) / 1000,
		LastShift:  float64(res.LastShiftMs) / 1000,
	}
}
