---
name: subtitle-autosync
description: "Subtitle AutoSync (ADR-0065, after Nuvio): internal/subsync reads Matroska Cues for the file's own subtitle timing, AddSubtitle retimes addon files before sub-add, Player.SubtitleSync status, autoSyncSubtitles setting, spike numbers and corpus recipe"
metadata:
  type: project
---

Built 2026-11-24 from a spike the same day (docs/spikes/subtitle-autosync.md); the user said "i'll do the tests myself. just implement" mid-spike, so live checks in the app are theirs.

- **Go:** `internal/subsync` (matroska.go Cues loader over `ranges`, align.go, subtitle.go retime, sync.go `Sync` + gate 0.4/0.05/300 ms). `playback.StartSync` at every `Load` (desktop `startSync` in subtitles.go, iOS iosplayer/subsync.go), cancelled by the next Load / closeSession. `AddSubtitle` with `Subtitle.AutoSync` waits ≤ `SyncWait` 6 s, then records `synced[id]`; `SubtitleSync(id)` is on `playback.Engine`. A Load during the wait returns ErrNotPlaying (stale `syncRef`). Local download subtitles (`addLocalSubtitle`) aren't synced.
- **Frontend:** `settings.autoSyncSubtitles !== false` → `autoSync`; `added` has `syncs` (id → SubtitleSync) and `retired` (synced copies swapped out by "Use original timing", kept hidden via `addedIds`); `originalTiming` ref keeps that choice across reloads. `syncSummary` in lib/subtitles.ts words it; panel badge + Timing note; touch TracksSheet under Timing. Route test mocks need `SubtitleSync` on `@bindings/player`; `profileSettings()` has `autoSyncSubtitles: true`; store migrate_test sets it true for old fixtures.
- **Spike recipe:** `spikes/subtitle-autosync` (own module), corpus from TorBox `mylist` (read-only; `requestdl` links, never resolve via Torrentio, see [[stream-resolve]]), `SPIKE_CACHE` in the scratchpad for subtitle files and truth text (not committed; `results/refs/` is 20 MB and git-ignored). OpenSubtitles v3 ignores filename/videoSize extras. TorBox CDN sometimes 400s a fresh link once: retry.
- Related: [[addon-subtitles]], [[player-subtitles]], [[device-subtitles]], [[debrid-test-key]].
