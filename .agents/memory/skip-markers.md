---
name: skip-markers
description: "#69 skip intro/recap/credits: State.chapters + lib/markers.ts (chapter names, skipSegments checks), internal/markers asks IntroDB from Go (CORS), skipIntros (profile) / skipTimesOnline (device), card waits for credits; read before #58, #70, AniSkip"
metadata:
  type: project
---

#69 (ADR-0039 "Skip intro and credits (#69)"): Go observes `chapter-list` → `State.chapters`. `frontend/src/lib/markers.ts` turns chapter names into segments (whole names only), else uses IntroDB's from `internal/markers` (`Service.Segments({imdbId, season, episode})`, season/episode 0 = film, `GET https://api.introdb.app/segments`, no key). `skipSegments` clamps to the file, drops intros after credits (IntroDB has a bogus one for tt0371746), drops < 3 s. The player shows "Skip intro/recap/credits" bottom-right. `ProfileSettings.skipIntros` auto-skips intros and recaps once each. `DeviceSettings.skipTimesOnline` (default on) gates IntroDB, checked in Go too. `countdownFrom(duration, creditsStart)` waits for credits after 90 %, never before.

**Why:** IntroDB's CORS only allows introdb.app, so the webview can't call it. Starting the card before 90 % would let Play now leave the episode unwatched (Go marks watched at 90 %).

**How to apply:**
- Test files that reach /player with `watching` on an IMDb id call `@bindings/markers`: routes/player.test.tsx mocks it (`mocks.segments`) and `DeviceSettings` (`mocks.deviceSettings`). Other files can go without (the query just errors).
- New ProfileSettings/DeviceSettings fields break typed fixtures (player.test.ts, player.test.tsx `japaneseTracks`, settings.test.tsx).
- After a skip, `useAhead` holds the position at the target until mpv reports it: in tests, emit the landed position before seeking back.
- Kitsu ids get nothing. AniSkip (MAL id + episode) is the follow-up for anime.
- Related: [[next-episode]], [[player-service]], [[player-keys-media]].
