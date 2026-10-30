---
name: player-tracks
description: "#62 audio/subtitle pickers: LoadOptions languages/captions/size, mpv selection settings, Set*Track/SubtitleDelay/SubtitleSize, menus, Z/X, what persists, macOS captions check gotcha"
metadata:
  type: project
---

#62 (ADR-0039, "Tracks and subtitles"): `LoadOptions` carries `audioLanguage`, `subtitleLanguage`, `captions` (on/off/system), `subtitleSize`. Build it with `loadOptions(start, settings, lastTracks)` in `lib/player.ts`; every `Player.Load` call site must use it. Go sets mpv properties before loadfile (captions off = forced-only via `subs-fallback=no`; on = `subs-fallback=yes` + `subs-fallback-forced=no`). `Service.SetAudioTrack/SetSubtitleTrack(0 = off)/SetSubtitleDelay/SetSubtitleSize`. State has `subtitleDelay` (rounded to ms: mpv stores a float32) and `subtitleSize`. Tracks have `forced` and `hearingImpaired`.

**Why:** #63 (addon subtitles), #65, #67 and #68 build on these menus and rules.

**How to apply:**
- Subtitles menu only shows when the file has subtitle tracks; Audio only for 2+. #63's `sub-add` tracks come through `track-list` with `external: true`, so they appear in the menu automatically.
- Size picked in the player saves to the profile's `subtitleSize`; delay is per session on purpose (not a profile default).
- Z/X (±0.1 s) are taken; #67 should keep them or move them knowingly. Window key handler ignores keys while a player menu is open (`menuOpen`).
- `osCaptions` (MediaAccessibility) can't be tested by flipping prefs from a CLI: `MACaptionAppearanceSetDisplayType` from an unsigned tool writes a per-app value and the read ignores it. Needs a manual toggle in System Settings > Accessibility > Captions.
- `testdata/tracks.mkv` is the multi-track fixture. For in-app checks, a 60 s multi-track clip from ffmpeg `testsrc2` plus the dev-play hook from [[player-service]] works; drive menus with `window.ExecJS` clicks on `[aria-label="Subtitles"]`.
- Related: [[player-controls]], [[player-service]].
