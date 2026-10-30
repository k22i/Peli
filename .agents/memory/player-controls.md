---
name: player-controls
description: "#61 player controls: seek-bar.tsx (Base UI slider, Scrub while dragging), useAhead/latestOnly/useIdle in lib/player.ts, heading from playerHeading, test and in-app screenshot gotchas"
metadata:
  type: project
---

#61 built the controls on #60's `/player` (ADR-0039). `components/player/seek-bar.tsx` (Base UI `Slider` directly: coss's slider has fixed app-surface styles, wrong over video), controls in `player-page.tsx`. `lib/player.ts` adds `formatTime`, `latestOnly` (one call in flight, newest next), `useAhead` (optimistic value until state catches up or 3 s), `useIdle`. Go gained `Service.Scrub` (`seek … absolute+keyframes`) for drags; release does an exact `Seek`. ±10 s seeks absolutely from the shown position, so repeated presses add up. History state `player` has `{title, episode?, source}`, from `playerHeading(meta, videoId, fallback)` in lib/title.ts.

**Why:** #62–#70 add to this screen; the patterns keep it optimistic (100+ ms round trips on slow machines).

**How to apply:**
- New player actions: show with `useAhead`, send via `latestOnly` if they can burst. Keep `tabIndex={-1} aria-hidden` on the video surface button, so "Play"/"Pause" names stay unique.
- Base UI slider: `thumbAlignment="edge"` hides the thumb input in jsdom (no layout), so role queries fail; the player uses the default (center). Keyboard changes commit via `onValueCommitted`; a drag ending where it began commits nothing, so seek-bar.tsx ends drags on window pointerup.
- Space is prevented on keydown **and** keyup, or a focused button also clicks. Esc leaves fullscreen first.
- In-app check: the dev-play hook from [[player-service]] works; set `Start` within the clip (a start past the end just ends it). Drive hover/wake with `window.ExecJS` dispatching a `PointerEvent` on `[data-testid=seek-bar]`. A test build window may get used by the user: if captures show content you didn't play, stop and ask.
- The rest of the keys and the OS media controls came with #67: [[player-keys-media]].
