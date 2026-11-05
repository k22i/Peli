---
name: stream-ranking
description: "How Sinag ranks streams (#51): lib/ranking layout, worker + RankingSession, useRankedStreams restarts on ctx/prefs, accuracy gate + accuracy.md snapshot, timing; read before #52, #56, #58, #68"
metadata:
  type: project
---

The ranking engine (#51, ADR-0035) is `frontend/src/lib/ranking/`: `parseStream` → `judge` → `scoreStream` (all weights in `defaultWeights`) → `StreamEngine` (incremental `add`, `view`, `pinTop`, `takeChanges`), `rankStreams()` for a whole list. It runs in one shared Web Worker (`worker.ts`, `protocol.ts`); the page side is `RankingSession` (`ranker.ts`), falling back to the page when there's no `Worker` (jsdom). The picker uses `useRankedStreams(sources, ctx, prefs)` in `lib/streams.ts`; `titleContext()` builds ctx from meta + video id, `rankingPrefs(profile, device, remembered)` from the audio language list and the device's cap/HDR/DV settings ([[stream-preferences]]).

**Why:** #6 measured ~1,400 streams per Comet answer; the worker + 150-slices keep the page under a frame. The user wants our own code, no ranking library.

**How to apply:**
- #52 is done (see [[stream-picker]]): it reads `view.top`/`view.groups` and pins on first focus/pointer-down or play.
- #56 is done (see [[plugin-sandbox]]): plugin streams feed the same session under `plugin:<id>`. #58 is done: `Prefs.remembered` changes only `#best()` ([[remembered-source]]).
- Parser changes: `vp test run -u` rewrites `src/lib/ranking/corpus/accuracy.md` (a file snapshot); the accuracy test fails CI below #6's targets. The blind split was seen while fixing #51, so new labels must be drawn before the change they test.
- Timing: `RANKING_TIMING=1 vp test run src/lib/ranking/timing.test.ts --silent=false` (V8). Vitest won't run under Bun; for JSC, copy that loop into a scratchpad Bun script (Bun resolves `@/` via frontend/tsconfig.json). Scripts in `frontend/scripts/` can't import `src/` (tsconfig.node TS6307).
- Route tests that render the picker must mock `ProfileSettings` in `@bindings/store`; ranking lands a tick after a pill updates, so use `findBy…` for the summary.
- `vitest` `bench` isn't exported from `vite-plus/test`.
- Follow-ups (2026-10-30): #97 AllDebrid/Premiumize cache markers (P0, needs #54 keys), #98 resolution cap / HDR / DV / language-order settings (done: [[stream-preferences]]), #99 title matching with TMDB translated titles (report-only until then), #100 anime episode map.
- Related: [[stream-requests]], [[tmdb-key]], [[addon-protocol-client]].
