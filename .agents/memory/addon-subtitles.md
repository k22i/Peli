---
name: addon-subtitles
description: "#63 addon subtitles: lib/subtitles.ts (target, useAddonSubtitles, byLanguage, autoSubtitle), Player.AddSubtitle downloads in Go, re-add after reload, language saved on pick; test gotchas"
metadata:
  type: project
---

#63 (ADR-0039, "Addon subtitles"): `frontend/src/lib/subtitles.ts` — `subtitleTarget(type, videoId, stream, addonName)` goes into history state `player.subtitles` (streams-page builds it from `resolvePick`'s `attempt`), `useAddonSubtitles(profileId, target)` asks enabled subtitle addons (`useStreamAddons`, not VisibleAddons), `subtitleLanguage` maps addon codes (`pob` → pt-BR) via `Intl.Locale`, `byLanguage`, `autoSubtitle`. Go: `Service.AddSubtitle(ctx, {url, lang, title}) → track id` (downloads itself so mpv doesn't send the stream's headers; temp dir per session, removed in closeSession), `Service.SystemCaptions()`.

**Why:** #65 (next episode), #67 and #68 (stream switcher) load new files on the same screen; external tracks vanish on every `loadfile`.

**How to apply:**
- A new `Player.Load` from the player screen must call `reloaded()` in player-page.tsx, so the addon subtitles showing are added again; a new file (next episode, #65; another stream, #68) needs a new `subtitles` target, not a re-add.
- Picking any non-forced subtitle track saves its language as the profile's `subtitleLanguage`; the auto-add never saves.
- Route tests: `mocks.settings` (ProfileSettings), `mocks.addons` (Store.Addons), `mocks.addSubtitle`, `mocks.systemCaptions`; serve OpenSubtitles' fixture by stubbing `fetch`. Language submenus open in jsdom by focusing the trigger and pressing ArrowRight; a submenu is a `menu` named by its trigger's text ("English3").
- Live check: OpenSubtitles v3 (`opensubtitles-v3.strem.io`) answers with `subs5.strem.io/.../subencoding-stremio-utf8/...` URLs that mpv reads as subrip.
- Related: [[player-tracks]], [[player-service]], [[addon-protocol-client]].
