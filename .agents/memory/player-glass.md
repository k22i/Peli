---
name: player-glass
description: "#121 player floating glass bar: capsule layout, --above-bar overlay layer, ControlButton glass/large, plain-white text rule, centre flash, menu offset, built-app blur check still open, screenshot rig"
metadata:
  type: project
---

#121 (redesign epic [[redesign-epic]]) rebuilt the `/player` chrome in `components/player/player-page.tsx` (render section from `const failure =`): a light top gradient (`from-black/45 h-28`, pointer-events-none) + a drag row (glass `Back` `ControlButton glass`, title in `text-heading`, torrent pill), a bottom gradient + the capsule (`glass-media-strong`, `inset-x-6 bottom-6 max-w-5xl`; mini `inset-x-2 bottom-2 rounded-2xl`). Row 1: `data-testid="elapsed"`, `SeekBar`, `data-testid="remaining"` (`-1:23:26`, fixed `ch` widths so the bar doesn't shift; mini has neither, it keeps "pos / dur" in its second row). Row 2 is `grid-cols-[1fr_auto_1fr]`: volume (always visible `w-24`; the mini keeps the hover reveal), Back 10 / Play (`large`) / Forward 10, then the menus. Overlays sit in one layer `bottom-(--above-bar)` (a class on the root: `8.375rem`, mini `6.25rem` = bar margin + height + gap): resume toast at the start, Skip button and `NextEpisode` (no longer positions itself) in a column at the end. Centre feedback is `data-testid="playback-flash"`, `starting:` variants (CSS only, no keyframes), `togglePause` sets it.

**Why:** the user's Apple TV-style floating bar; the ticket also asks to record whether glass blurs over the native video.

**How to apply:**
- If you change the bar's height (row sizes, padding), update `--above-bar` and the menu `sideOffset` (46 + 12: the buttons sit 46 px under the bar's top edge, so a bare 12 overlapped the capsule).
- Text on `glass-media-strong` is plain `text-white`; `white/70` is 3.2:1 over a white frame (`contrastPairs` has the shortcut-key and failure pairs). The Skip button, glass Back and next card keep their tint on hover with `hover:bg-(--glass-media[-strong])` (the ghost variant's hover colour would replace it) plus `hover:before:bg-white/15`.
- Time pill in the seek bar: the segment name is white with an amber dot (amber text fails on strong glass over white).
- The built-app blur check is **open**: this run had no screen-capture permission. `wails3 task darwin:package` took 30 s with Homebrew's mpv, a dev-play hook in main.go plus a file-polled `SINAG_DEV_JS` channel into `window.ExecJS` worked for driving, and `CGPreflightScreenCaptureAccess()` false means `screencapture -l` can't work: grant the terminal/Orca Screen Recording first. Hook recipe: [[player-service]].
- Tests weren't run (the user asked to skip them): `routes/player.test.tsx` changed the two time assertions (`elapsed`/`remaining` test ids instead of "10:00 / 2:00:00") and gained two tests (volume slider in the bar + mini's time, the centre mark); `contrast.test.ts` gained two pairs.
- Screenshot rig: throwaway `vite.shot.config.ts` aliasing `@bindings/<pkg>` to a Proxy `Service` (handlers on `window.__h`, `store`/`player` models re-exported) and `@wailsio/runtime` to a stub with `window.__emit`; navigate with `window.router`, `player:state` via `__emit`; a `fetch` stub for manifests and Torrentio, real Cinemeta for the series. The next-episode card needs position ≥ 90 % of the file (3250 of 3480). `backdrop-filter: none` injected to mimic the native video.
- Related: [[player-controls]], [[next-episode]], [[mini-player]], [[glass-materials]].
