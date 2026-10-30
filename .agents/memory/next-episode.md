---
name: next-episode
description: "#65 next-episode countdown: lib/next-episode.ts (nextEpisode, countdownFrom, usePreparedNext), NextEpisode card, PlayerPage/PlayerFile split keyed by source URL, torrents deferred, same-pack file switch in internal/torrent; read before #58, #67, #68, #69"
metadata:
  type: project
---

#65 (ADR-0039 "Next episode (#65)"): the card shows from 90 % of ≥ 60 s (the watched point, as the user asked) and counts down to the **end of the file**; eof or Play now plays the next episode in the same mpv session, Cancel leaves at the end as before. `usePreparedNext` asks/ranks/resolves the next episode's top pick in advance (settles 500 ms after every addon answered). Torrents are **never opened in advance** (one torrent at a time: it would stop the one playing). No stream / failure → stream picker for the next episode replaces /player.

**Why:** the user commented on #65 "start the countdown when the episode is marked as watched"; no outro markers until #69.

**How to apply:**
- `PlayerPage` owns the session (Stop, torrent Release via the last real `playing.source`, since leaving re-renders it once with the next screen's state); `PlayerFile` is keyed by `source.url`, so per-file state resets. A new file = `navigate({to: "/player", replace: true, state})` with new `watching`/`resumedAt`/`subtitles`.
- `switching` ref ignores player:ended while the next opens. Released torrent only when the next is a link.
- internal/torrent: `session.file` is an atomic pointer; `Open` with another file of the same hash switches it (old URL 404s). Before this it silently returned the first file.
- #58 hook: put the remembered source first in `usePreparedNext` (same as the picker).
- Tests: `next episode` describe in routes/player.test.tsx; stream URLs are `%3A`-encoded (`tt0903747%3A1%3A2.json`); Resolve/Open mocks need `cancel`.
- Stubbed screenshot of /player: throwaway `vite.stub.config.ts` + `stub-main.tsx` in frontend/ exposing `window.router`, then `router.navigate({to: "/player", state})` over CDP; Player.Snapshot stub sets position/duration. Delete both after.
- Related: [[progress-resume]], [[player-service]], [[stream-resolve]], [[torrent-streaming]].
