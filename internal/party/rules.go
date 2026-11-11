package party

import (
	"math"
	"slices"
	"sync"
	"time"

	"github.com/k22i/Peli/internal/backend"
)

// The rules every member follows to stay in step, as Nuvio's apps follow
// them, so a party of Peli and Nuvio members agrees (ADR-0051). Times are
// in milliseconds of the server's clock.
const (
	// Drift past nudgeStart is corrected by playing nudgeFactor faster or
	// slower until it's under nudgeStop; past seekThreshold, by seeking.
	nudgeStartMs    = 250
	nudgeStopMs     = 80
	seekThresholdMs = 1500
	nudgeFactor     = 0.05
	// Paused, a member more than this away seeks to the party.
	pausedToleranceMs = 500
	// A jump of more than this between two playbacks is a seek, for notices.
	seekNoticeMs = 2000
	// A member who fell behind joins in again once within this of the party.
	rejoinGapMs = 2000
	// How far behind is told to the others: rounded to this.
	behindStepMs = 5000
)

// expectedPosition is where the party's playback is at server time now.
func expectedPosition(p backend.PartyPlayback, nowMs, durationMs int64) int64 {
	position := p.PositionMs
	if !p.Paused {
		elapsed := max(0, nowMs-p.At)
		position += int64(float64(elapsed) * rate(p))
	}
	position = max(0, position)
	if durationMs > 0 {
		position = min(position, durationMs)
	}
	return position
}

// rate is p's rate, 1 when it was left out.
func rate(p backend.PartyPlayback) float64 {
	if p.Rate <= 0 {
		return 1
	}
	return p.Rate
}

// newer reports whether candidate replaces current: a higher seq, or the
// same seq from a higher member id, so every member settles on the same one.
func newer(candidate backend.PartyPlayback, current *backend.PartyPlayback) bool {
	if current == nil {
		return true
	}
	if candidate.Seq != current.Seq {
		return candidate.Seq > current.Seq
	}
	return candidate.MemberID > current.MemberID
}

// What a member does about drift.
type correction struct {
	kind       int
	positionMs int64
	rate       float64
}

const (
	inSync = iota
	seekTo
	nudge
)

// correct says how a member at localMs, when the party is at expectedMs,
// gets back in step; nudging is whether it plays at a nudged rate now.
func correct(localMs, expectedMs int64, p backend.PartyPlayback, nudging bool) correction {
	drift := localMs - expectedMs
	distance := drift
	if distance < 0 {
		distance = -distance
	}
	if p.Paused {
		if distance > pausedToleranceMs {
			return correction{kind: seekTo, positionMs: expectedMs}
		}
		return correction{kind: inSync}
	}
	threshold := int64(nudgeStartMs)
	if nudging {
		threshold = nudgeStopMs
	}
	switch {
	case distance > seekThresholdMs:
		return correction{kind: seekTo, positionMs: expectedMs}
	case distance > threshold:
		factor := 1 + nudgeFactor
		if drift > 0 {
			factor = 1 - nudgeFactor
		}
		return correction{kind: nudge, rate: rate(p) * factor}
	}
	return correction{kind: inSync}
}

// coordinator is the member who pauses the party for those still loading
// and resumes it: the host while online, else (unless only the host
// controls) the first member online, else this one.
func coordinator(members []backend.PartyMember, online map[string]bool, self, host string, hostOnly bool) string {
	if host != "" && (online[host] || host == self) {
		return host
	}
	if hostOnly {
		return host
	}
	for _, m := range members {
		if online[m.ID] || m.ID == self {
			return m.ID
		}
	}
	return self
}

// Actions the notices name.
const (
	ActionPaused  = "paused"
	ActionResumed = "resumed"
	ActionSeeked  = "seeked"
	ActionSpeed   = "speed"
)

// actionOf is what someone did to go from previous to next, or "".
func actionOf(previous *backend.PartyPlayback, next backend.PartyPlayback) string {
	if previous == nil || previous.Waiting || next.Waiting || previous.MediaKey != next.MediaKey {
		return ""
	}
	switch {
	case previous.Paused != next.Paused:
		if next.Paused {
			return ActionPaused
		}
		return ActionResumed
	case math.Abs(rate(*previous)-rate(next)) > 0.01:
		return ActionSpeed
	}
	jump := next.PositionMs - expectedPosition(*previous, next.At, 0)
	if jump > seekNoticeMs || jump < -seekNoticeMs {
		return ActionSeeked
	}
	return ""
}

// What a member who can't control playback gets for a seek of their own.
const (
	seekBlocked = iota
	// Back, more than rejoinGapMs behind the party: they watch on alone.
	seekBehind
	// Forward while behind: they catch up with the party.
	seekCatchUp
)

func ownSeek(targetMs, partyMs int64, behind bool) int {
	switch {
	case targetMs < partyMs-rejoinGapMs:
		return seekBehind
	case behind:
		return seekCatchUp
	}
	return seekBlocked
}

// reportedGap rounds how far behind a member is for the others: to
// behindStepMs, at least one step.
func reportedGap(gapMs int64) int64 {
	return max(behindStepMs, (max(0, gapMs)+behindStepMs/2)/behindStepMs*behindStepMs)
}

// waitingMembers are those watching mediaKey who are loading or buffering,
// but for ignored: those the party stopped waiting for.
func waitingMembers(presence map[string]presenceState, mediaKey string, ignored map[string]bool) []string {
	var out []string
	for id, p := range presence {
		if p.MediaKey == mediaKey && (p.Status == StatusLoading || p.Status == StatusBuffering) && !ignored[id] {
			out = append(out, id)
		}
	}
	slices.Sort(out)
	return out
}

// clock is the server's clock as this device reads it: anchored at the
// sample with the shortest round trip, half of which it adds, and moved on
// by the monotonic clock. Before any sample it's the wall clock.
type clock struct {
	mu        sync.Mutex
	now       func() time.Time
	anchorMs  int64
	anchorAt  time.Time
	bestTrip  time.Duration
	hasSample bool
}

func newClock(now func() time.Time) *clock { return &clock{now: now, bestTrip: math.MaxInt64} }

func (c *clock) nowMs() int64 {
	c.mu.Lock()
	defer c.mu.Unlock()
	if !c.hasSample {
		return c.now().UnixMilli()
	}
	return c.anchorMs + c.now().Sub(c.anchorAt).Milliseconds()
}

// add takes the server's time serverMs, asked for at sentAt.
func (c *clock) add(serverMs int64, sentAt time.Time) {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := c.now()
	trip := max(0, now.Sub(sentAt))
	if trip > c.bestTrip {
		return
	}
	c.bestTrip = trip
	c.anchorMs = serverMs + trip.Milliseconds()/2
	c.anchorAt = now
	c.hasSample = true
}
