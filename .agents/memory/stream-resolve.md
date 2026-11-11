---
name: stream-resolve
description: "How a picked stream is resolved (#53): internal/streams Resolve → Source, notice/expired codes, lib/resolve.ts resolvePick (pick then alternates, refresh on expired), tools/ttff, TorBox side effects; read before #60, #101, #55, #58, #68"
metadata:
  type: project
---

Resolving (#53, ADR-0037): Go `internal/streams` `Service.Resolve({url, headers}) → Source{url (final CDN link), origin, headers, userAgent, contentType, size}` with one `Range: bytes=0-0` GET; codes `caching/denied/busy/failed` (notice video ≤ 16 MiB, read by file name), `expired` (401/403/404/410), `not_video`, `unavailable`, `redirects`, `unreachable`, `timeout`. Frontend `lib/resolve.ts` `resolvePick(candidate, {refresh, signal})`: the pick, then alternates one at a time; `expired` → asks the addon again once (`fetchQuery` staleTime 0) and matches by `dedupKey`. The picker shows one toast, "Opening…" → outcome.

**Why:** debrid addons answer an uncached file with a 302 to a short "downloading" mp4 rather than an error, and CDN links expire. Go's client would send the Torrentio resolve URL (with the debrid key) as Referer on redirects, so CheckRedirect strips it.

**How to apply:**
- #60 did this: `Player.Load(source)` sets `http-header-fields` as a list, and the player screen re-resolves `origin` on `expired` mid-play (`reloadExpired`). See [[player-service]].
- **Resolving a Torrentio+TorBox stream adds the torrent to the user's TorBox list**, cached or not (the uncached one starts a download). In live tests only resolve torrents already in the account (list them via `/v1/api/torrents/mylist`, read-only). Deleting from TorBox was blocked by the auto-mode classifier; the probe's two entries from 2026-10-30 (ids 131308501, 131308471) were left for the user.
- Torrentio returns 403 to Go's default User-Agent: always send Sinag's.
- TTFF: `set -a; . spikes/stream-ranking/.env; set +a; go run ./tools/ttff -id series/tt1190634:1:5 -hash <infohash> -mbps 50 -runs 1`. One run per new file gives cold numbers. Packs already in the account (The Boys S01 0d1484a8…, Summer I Turned Pretty S03 e5225d2a…, Widow's Bay S01 7f30e5d2…) give cold samples with no new entries. Cold median was 3.3 s, warm 0.7–1.4 s; the target moved to #101.
- **#101 loopback hand-off was tried and scrapped (2026-11-11).** A Go cache that fetched the head (1 MiB) and an MP4's tail (4 MiB) as Resolve answered, over the resolve's own kept connection, and served mpv from loopback. A/B in the app (ttff `-app`, 50 Mbit/s, VideoToolbox, fresh episodes from packs already in TorBox, batches alternated): plain 3.3 s median (n 10), hand-off 3.5 s (n 11); resolve ~2.0 s and open ~1.3 s in both. The resolve is Torrentio/TorBox server time, two thirds of the 3 s budget; mpv's open isn't bound by connection setup. Only resolving the top pick ahead (adds it to the user's debrid list) could meet #101; that's the user's call. Gotcha found on the way: Resolve must close its response before handing the Source on, or a follow-up request opens a new connection. The code is only in the Orca worktree `streams-101` (uncommitted). Dan Da Dan pack `e98274c7` reads 63 MB before its first frame (12 s) with or without; leave it out of samples.
- Route tests mock `@bindings/streams` `Resolve` as a promise with `cancel`; the `serve()` helper takes `new Each(() => answer)` for per-request answers.
- Related: [[stream-picker]], [[stream-ranking]], [[debrid-test-key]], [[spike-ticket-workflow]].
