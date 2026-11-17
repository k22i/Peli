---
name: touch-player-chrome
description: "#130 touch player chrome: touchLayout branch in player-page.tsx, touch-chrome.tsx pieces, seek bar touch/scrubAt, scrub state (scrubTo/endScrub for #131), --touch-chrome, sheets, lift, iOS Stats"
metadata:
  type: project
---

#130 (epic #126, 2026-11-17) replaced the touch dock with a YouTube/Netflix/Infuse chrome. In `player-page.tsx`, `touchLayout = isTouch() && !mini` picks `touchControls` inside the `controls` div; the desktop and mini JSX is the other branch, unchanged (desktop `routes/player.test.tsx` failures equal main's).

**Pieces (`components/player/touch-chrome.tsx`):** `TouchTopRow` (Back chevron, `h1` title 15 pt + episode 13 pt, `Audio and subtitles` button, Lock only when `onLock` is passed, `more` slot), `GlassButton` (md 44 / skip 48 / play 64, `material-media`; `bare` = no disc), `RowButton`, `TouchSpeedMenu`, `TouchMoreMenu` (Speed for films only, Sleep timer, Playback stats; no "Report a problem" yet: #127's `Diagnostics.ShareLogs` wasn't on main), `ScrubLabel`, `TracksSheet` (Audio | Subtitles columns, addon subtitles via `byLanguage` as `fieldset`/`legend` groups, Subtitle style… → `setPanel("style")` opens the old SubtitlePanel's Style tab, Timing… inline −/+ through `timeSubtitlesBy`), `EpisodesSheet` (season chips; pick → `chooseEpisode` navigates to the stream picker, `replace`). `touchChromeRem` feeds `liftToClear(h, false, 16, covers)` (new 4th arg).

**Why:** the dock was ~45 % of a landscape iPhone; the user asked for less chrome. #131 (gestures) builds on it.

**How to apply:**
- Scrub: page state `scrub {from,to}`; `scrubTo(to)` (keyframe `Scrub`) and `endScrub(commit)` are the hooks for #131's swipe; `SeekBar touch scrubAt={scrub?.to}` follows an outside scrub (thumb + bubble). While `scrub` is set, `faded` hides everything but the seek row, prompts too.
- Heights: seek row `h-8`, bottom row `h-8` (series only), container `pb-[max(0.5rem,env(safe-area-inset-bottom))]` → ~53 pt film / ~85 pt series on an iPhone on its side. Root var `--touch-chrome` places the prompt rail; resume is `resumePill` at the top centre. NextEpisode has `compact` (240 pt, no thumbnail).
- Centre cluster's container is `pointer-events-none`; children get `*:pointer-events-auto` only while `shown` (auto children would catch taps through hidden controls).
- `PlayerMenu` gained `side`/`align` (defaults top/end); More opens downward.
- iOS `Player.Stats` now reads the engine (`iosplayer.Engine.Stats`, `service_ios.go` type-asserts); the `rotating` wrapper embeds `*Engine`, so it's promoted.
- Tests: `describe("touch player")` in routes/player.test.tsx (`onIOS()`); the scrub test stubs `HTMLElement.prototype` pointer capture and removes it after. Under load, add `--testTimeout=30000` before calling a failure real.
- Not seen on a device or simulator (simulator use was stopped for this ticket): heights, sheets, iPad split view. Thumbnails while scrubbing are a follow-up. Related: [[player-glass]], [[player-controls]], [[player-subtitles]], [[ios-port]], [[ios-polish-epic]].
