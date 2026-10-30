---
name: progress-resume
description: "#64 progress/resume/watched: Go reports (player.ReportTo → internal/watching.Reporter), FlushProgress keeps the watched grace, resume read from the store at pick time, Start over pill; read before #65, #67, #68"
metadata:
  type: project
---

#64 (ADR-0039 "Progress, resume and watched"): progress is kept in **Go**, not React. `LoadOptions.watching` (profile, content id/type, video id, season, episode, title) → `player.ReportTo` gets a `Report` every 10 s playing and on pause/seek/end/stop/replace/quit → `watching.Reporter` saves progress, marks watched at ≥ 90 % of ≥ 60 s (once), and calls `Pusher.FlushProgress` (not `Flush`) on anything but a periodic report. Frontend: `watchingFor` and `resumePoint` in `lib/title.ts`; history state `player.watching` + `player.resumedAt`; `invalidateWatching` after Stop. `flushPushes()` is gone.

**Why:** a quit or closed window never runs React cleanup, and a forced flush would push the watched item the server makes itself from the finished progress (M0 gotcha 2).

**How to apply:**
- Every `Player.Load` passes `watching` as `loadOptions(start, settings, tracks, watching)`; a new file (next episode #65, another stream #68) needs a new `watchingFor(...)`, not the old item.
- The picker reads the store's progress at pick time (`titleProgressQuery`, `staleTime: 0`) and pulls on mount; the card's `resumeAt` is only the fallback.
- Player tests: `ReportTo(s, got.add)` and shorten `s.reportEvery`; a playback-restart before the first frame isn't a seek (`ses.started`).
- Not done in-app: #23's guest check is a Go test (`TestGuestReportsMakeNoNuvioRequests`).
- Related: [[sync-module]], [[player-service]], [[title-page]], [[stream-picker]].
