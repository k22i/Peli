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
- `skipTitle` takes the IMDb id from the episode's video id first (`tt0903747:2:3`): the user's catalogs give series ids as `tmdb:1396`, and IntroDB takes IMDb ids only (`tmdb_id` is "Invalid query params"). The first version only read `contentId` and never asked anything for them.
- Live check without picking a stream: a temporary `SINAG_DEV_PLAY` hook (main.go ExecJS → a `window.__devPlay` in main.tsx that calls `Player.Load`, then `router.navigate` to /player with `watching`, and logs to Go through a `dev:log` event). `screencapture -l` failed here ("could not create image from window"), so the hook logs the button's rect and `elementFromPoint` instead. Use a copy of the store with `SINAG_NUVIO_URL=http://127.0.0.1:9` so progress isn't pushed. Make long clips by remuxing (`-c copy`), not with lavfi + a second input (it ran forever). Never commit the hook.
- The seek bar marks the segments (`SeekBar segments`, `data-testid="segment"` with `data-kind`) in `bg-warning` (#f59e0b), under the played part so only what's left stays amber; hovering one prefixes the time label with `segmentNames[kind]`.
- Kitsu ids get nothing. AniSkip (MAL id + episode) is the follow-up for anime.
- Related: [[next-episode]], [[player-service]], [[player-keys-media]].
