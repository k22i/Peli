---
name: device-subtitles
description: Per-device "Always show subtitles" (DeviceSettings.subtitles always + style), smartSubtitle pick, and off = sub-visibility=no to dodge mpv 0.41's refresh-seek stall
metadata:
  type: project
---

Built 2026-11-23 by four mistral-vibe workers (user's request: always-on subtitles saved per device, with a style; a smart pick; video keeps playing while subtitles turn on or off).

- **Store:** `DeviceSettings.Subtitles DeviceSubtitles{Always, Style}`, default off + `DefaultSubtitleStyle()`, empty saved style filled on load and save, shared `validSubtitleStyle`. TS literals of `DeviceSettings` in tests need `subtitles` (fixtures.ts `deviceSettings()`, player/streams/downloads tests, lib/streams.test.ts).
- **Why playback stopped:** mpv 0.41 refresh-seeks when a subtitle stream *embedded in the file* is selected (`demux.c` `refresh_track` → `initiate_refresh_seek`): it clears every queue, video included, and re-reads from now−11 s over the network. Deselecting doesn't. External `sub-add` tracks have their own demuxer, so they don't stall. No option turns this off.
- **Fix:** `SetSubtitleTrack(0)` sets `sub-visibility=no` and keeps `sid`. Picking the same id again only sets `sub-visibility=yes`. Every load and every `AddSubtitle` (select) sets it to yes. `sub-visibility` is observed, and `playback.HideMainSubtitle` clears `Selected` on the main sub track while hidden, so the frontend reads it as off. This is the same on desktop (`internal/player`) and iOS (`internal/iosplayer`). Switching between two *different* embedded tracks still refresh-seeks.
- **Frontend:** `loadOptions(..., device)` forces captions on with the device style and `wantedSubtitleLanguage` (profile subtitle language → first audio language → navigator.language → en). `smartSubtitle(tracks, addonSubs, want)` picks: own full text track, non-HI, default-flagged, then an addon's, then a single untagged track. It never saves the language. "Save as my style" goes to the device while always is on. Settings › Languages has an "On this device" group.

**How to apply:** don't go back to `sid=no` for "off". Any new place that reads the main subtitle track must go through the hidden-aware `Selected`. The worker bug to watch for: mpv's `sub-visibility` is true when *visible*. Related: [[player-tracks]], [[addon-subtitles]], [[player-subtitles]], [[orca-worker-model]].
