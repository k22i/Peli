---
status: accepted
date: 2026-11-17
---

# Pre-resolving the top pick: an opt-in device setting, off by default, that resolves a cached debrid top pick before it's picked

#101's target is a first frame within 3 s of the pick on 50 Mbps, for the first play of a cached debrid stream. Resolving the pick ([ADR-0037](0037-resolving-streams.md)) takes about 2 s of that, and almost all of the 2 s is spent on Torrentio's and TorBox's servers: Torrentio's redirect asks TorBox for the file, then TorBox's `requestdl` runs, then the CDN sends its first byte. The loopback hand-off (below) showed that Peli can't make the player's open any cheaper. The only way left to the target is to resolve before the pick.

The side effect decides how it ships. **Resolving a Torrentio+TorBox stream adds its torrent to the user's TorBox list**, even when it's cached and even if it never plays. That happens on the addon's side, so Peli can't avoid it. The user chose an **opt-in setting that's off by default**.

## The setting

`DeviceSettings.preResolve` (bool, `false` by default and in records saved before it existed, since settings decode over the defaults). It's the "Start cached streams sooner" switch in Settings › Streaming, in a "Starting" group between Picture and Torrents. The row says what it costs: *"This adds the stream to your debrid service's list before you press play, even if you never play it."*

It's a device setting, as torrent streaming is ([ADR-0040](0040-torrent-streaming.md)). Both are side effects the person at this machine opts into, and they sit side by side in the same pane. Debrid keys belong to the addons ([ADR-0038](0038-debrid-keys-stay-with-addons.md)), so there's no debrid account in Peli that a per-account setting could attach to. A kids profile never resolves ahead, whatever the setting says, because the entry would land in the parent's debrid list. Bindings and the full-object `DeviceSettings` mocks in tests have the field.

## What resolves ahead

`lib/pre-resolve.ts`, `usePreResolve(view.top, {enabled, answered, refresh})`, called by the stream picker:

- **When:** every source has answered and everything that ranks the streams has loaded: addons, plugins, the title's details, the episode map, the remembered source (`useStreamChoices().answered`). After that the top pick has to stay the same for 500 ms (`settleAfter`, the same wait `usePreparedNext` uses).
- **What:** only a top pick that `preResolvable` accepts: `parsed.cached === true`, a debrid service named, a link (`stream.url`), and an addon source, never a plugin. A torrent with no link, an uncached debrid stream (resolving it starts a download) and a direct link all wait for the pick.
- **How:** through `resolvePick`, with the candidate's alternates removed and torrents refused. Each copy that resolves is another entry in a debrid list, so only the pick resolves ahead. If it fails, the real pick tries the copies as before. An `expired` answer still asks the addon again once, inside `resolvePick`.
- **At most one, once:** one resolve is held or out at a time. A key (addon + link) never resolves ahead twice in one picker visit, even if the ranking moves away from it and back.
- **Dropped:** when the top pick changes or goes away (the resolve still out is aborted), when the user picks a different stream (`take` of another candidate drops it), and when the picker unmounts (aborted).
- **Stale after 5 minutes** (`staleAfter`), counted from when it resolved. Then the pick resolves afresh. CDN links last longer than that. The cost of a stale link is the plain path, and the player's `expired` re-resolve ([ADR-0039](0039-player-service.md), `reloadExpired`) is still the fallback during playback.

`pick(candidate)` asks `ahead.take(candidate)` first. If it returns a promise, the pick uses it: a finished resolve plays at once, and one still out is awaited rather than asked for twice. If that promise rejects, the pick falls back to `resolvePick` with the copies. Once a pick has taken a resolve, a new top pick no longer aborts it.

`usePreparedNext` (#65, [ADR-0039](0039-player-service.md) "Next episode") already resolves the next episode's top pick ahead and never opens torrents ahead. It does this without a setting, because the user has already chosen to keep watching the show. The picker's hook follows the same approach (wait for every answer, settle, resolve only links, abort on leave), with the narrower rules above, because a picker visit doesn't mean the user will play the top pick.

## Numbers

`tools/ttff -app` (new): internal/player's libmpv session in a Wails window, with the real macOS video host, VideoToolbox decoding and audio muted (`PELI_MPV_OPTIONS=mute=yes`). The download goes through ttff's 50 Mbit/s loopback throttle. Each sample is a different episode from a pack already in the TorBox account (The Boys S01 `0d1484a8`, MKV; The Summer I Turned Pretty S03 `e5225d2a`, MKV; Widow's Bay S01 `7f30e5d2`, MP4), played once, so it's cold. The modes alternated episode by episode. Each sample opens a new player session at the pick and stops it after the first frame, as opening and leaving `/player` does. *Plain* is resolve + load. *Ahead* resolves, waits 3 s (the user reading the list), then times only the load. M1 Pro, 2026-11-17.

| | n | median | best | worst | ≤ 3 s |
|---|---|---|---|---|---|
| Plain (setting off) | 14 (+1 pilot at 4.69 s) | **4.43 s** | 3.68 s | 6.12 s | 0 of 14 |
| Resolved ahead (setting on) | 14 | **1.35 s** | 1.07 s | 2.41 s | 14 of 14 |

| By pack, median | Plain resolve | Plain load | Ahead load |
|---|---|---|---|
| The Boys (MKV, 1.2–2.1 MB to first frame) | 1.9 s | 1.96 s | 1.27 s |
| Summer I Turned Pretty (MKV, 0.8–1.8 MB) | 2.2 s | 2.17 s | 1.25 s |
| Widow's Bay (MP4, 4.5–6.0 MB) | 2.0 s | 2.93 s | 2.29 s |

- The acceptance criterion is met with the setting on: a median of 1.35 s, every sample under 3 s, the worst a 4K MP4 at 2.41 s. With it off the target isn't met (4.43 s). That's higher than the 3.3 s of #53 and the hand-off A/B, because each sample here includes opening the player session.
- **Resolving ahead saves more than the resolve.** The load itself was 0.6–0.8 s faster after a resolve 3 s earlier. The likeliest cause is the CDN: Resolve's ranged GET starts the edge fetching the file, and by the pick the head is warm. A user who presses P the moment the list settles gets less of that second saving. A pick made while the resolve is still out waits for it, which still saves the part already done.
- **No TorBox entries were added**: the list had 109 entries before and after (`/v1/api/torrents/mylist`, read only), because every sample came from a pack already there. In normal use, each top pick that resolves ahead and isn't already in the list adds one entry.

## Alternatives

- **Loopback hand-off (tried and scrapped, 2026-11-11).** A Go cache fetched the file's head (1 MiB), and an MP4's tail (4 MiB), over the resolve's own kept connection, and served mpv from loopback, to save mpv's new connection and first requests. In the app it measured a median of 3.5 s (n 11) against 3.3 s plain (n 10), with resolve ~2.0 s and open ~1.3 s in both. mpv's open isn't bound by connection setup, and the resolve is server time. The code was never committed. One finding survived: Resolve closes its response before it returns the Source, so the follow-up request reuses the connection.
- **Resolve ahead with no setting, or on by default.** Rejected by the user: it changes the user's debrid list without asking.
- **Resolve every cached stream on screen, or the top few.** Each one is another entry in the debrid list, and in a picker visit the user plays one stream at most. One at a time keeps the side effect to the stream most likely to play.
- **Resolve only through TorBox's own API (check the cache, then `requestdl`), bypassing the addon.** That needs Peli to hold the debrid key, which ADR-0038 rules out. It would also only cover TorBox.
- **mpv start-up options** (probe size, MP4 index at the end). These are #101's remaining task. They could shorten the load on both paths, MP4s most of all, but they can't touch the 2 s resolve.

## Not done here

- Tuning mpv's start-up for MP4s (above).
- Pre-resolving from the title page's Play before the picker opens. The picker is where the top pick is known.
- Telling the user which entries Peli added to their debrid list. Peli can't list a debrid account without its key.
