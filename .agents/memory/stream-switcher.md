---
name: stream-switcher
description: "#68 in-player stream switcher: StreamSwitcher sheet (S / Streams button), useStreamChoices (components/streams/stream-choices.ts) + StreamsSummary + usePlayKey shared with the picker, player.stream in history state marks Playing, switchStream loads at the Snapshot position; read before #58, #69, #70"
metadata:
  type: project
---

#68 (ADR-0039 "Stream switcher (#68)"): `components/player/stream-switcher.tsx` is a right-side coss `Sheet` (dark) with the picker's list. The picker's data is one hook now, `useStreamChoices(profileId, type, id, video, title)` in `components/streams/stream-choices.ts` (moved out of `streams-page.tsx` on 2026-11-22, breaking a party-pick import cycle; both files still import it there), with `StreamsSummary` and an exported `usePlayKey`; `StreamList` takes `playing?: (candidate) => boolean` and shows "Playing". History state `player.stream` is the addon `Stream` that resolved (set by the picker, the next episode and the switcher), matched with `sameStream`.

**Why:** the ticket asks for the ranked list inside the player and a switch that keeps the position; the picker and the panel must rank the same way.

**How to apply:**
- `switchStream` in `player-page.tsx`: resolvePick → `Player.Snapshot()` position (or `stoppedAt` after a failure) → `Load` with the same `watching` → `navigate("/player", replace)` with new source/stream/subtitles and `resumedAt: 0`. Same URL = no navigate (the file's screen is keyed by URL). Torrent released only when the new one is a link.
- No button without `watching`. The failure overlay's "Choose another stream" opens the panel when `watching` is known (else goes back as before).
- Keys: S opens it; while open the window key handler returns (`switcherOpen`), so the list owns arrows/Enter/P/I, and Base UI closes on Esc. New player keys go in `playerShortcuts` too ([[player-keys-media]]).
- #58 is done: `useStreamChoices` ranks with the remembered source and returns `usual`; switchStream saves the pick ([[remembered-source]]).
- Tests: `stream switcher` describe in routes/player.test.tsx (pilot streams at `tt0903747%3A1%3A1.json`, panel is `role="dialog"` named "Streams").
- Related: [[stream-picker]], [[next-episode]], [[progress-resume]], [[stream-resolve]].
