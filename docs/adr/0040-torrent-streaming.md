---
status: accepted
date: 2026-10-30
---

# Torrent streaming: anacrolix/torrent in-process, a loopback link for mpv, our own capped cache, off until turned on

#55 (F17) plays streams that are only a torrent: an addon's `infoHash` with no `url`, as Torrentio, Peerflix and TorrentsDB send without a debrid service. Until now the picker skipped them (ADR-0037). An embedded engine fetches the pieces around what the player reads, so playback starts before the download is done, and hands mpv the file as an ordinary HTTP link.

## Layout

| File | |
|---|---|
| `internal/torrent/torrent.go` | `Service`: `Open(Request) → Source`, `Status`, `Release`, `CacheSize`, `ClearCache`, `SetCacheSize`; the loopback HTTP server |
| `internal/torrent/cache.go` | The piece cache: one file per verified piece, oldest dropped past the cap |
| `internal/store/settings.go` | `DeviceSettings.TorrentStreaming` (off by default) and `TorrentCacheGB` (2, 5, 10, 20 or 50; 5 by default) |
| `frontend/src/lib/torrent.ts` | The request from a stream, the opener, status polling and its text, cache queries |
| `frontend/src/lib/resolve.ts` | `resolvePick`: copies with a link first, then torrents through `Torrents.Open` |
| `components/player/player-page.tsx` | Peers, speed and buffer at the top and under the spinner; `Release` after `Stop` |
| `routes/settings.tsx` | Playback › Stream torrents and Torrent cache |
| `nosqlite.go` | Stops a release build that would link SQLite (below) |

## The engine

**[anacrolix/torrent](https://github.com/anacrolix/torrent) v1.61** (MPL-2.0, file-level copyleft, allowed by CONTRIBUTING), in-process. It is the one mature Go engine with streaming readers: a `Reader` marks the piece it reads and the next as urgent and a readahead window after them, so pieces arrive in playback order and a seek moves the window. libtorrent through cgo would be faster to fetch but means a C++ build of Boost on three OSes for a P1 feature. A WebTorrent or peerflix process would mean shipping Node.

The client starts with the first `Open` and stops five minutes after the last torrent is let go, so it costs no memory, port or DHT traffic until someone streams a torrent, and the next pick within five minutes skips joining the DHT again. One torrent plays at a time: opening another drops the one before, and opening another file of the same torrent (the next episode in a pack, #65) switches the file it serves. It listens on a free port (a fixed one clashes with another client), uses the DHT, UPnP, the stream's own `sources` trackers and seven public trackers (Torrentio sends none), and doesn't do WebTorrent.

## The player gets a link

`Open` waits for the torrent's file list (at most 45 s, else `no_peers`), picks the file and returns a `streams.Source` like resolving does (ADR-0037): `http://127.0.0.1:<port>/<secret>/<info hash>/<file index>/<name>`, with origin `magnet:?xt=urn:btih:<hash>`. `Player.Load` takes it unchanged, so mpv gets ranges, seeks and its own read-ahead cache for free. Each request gets its own `Reader` (`http.ServeContent`), so mpv's second connection for an MP4's index doesn't move the first one's window. The first and last two pieces are asked for at once: MP4s often keep their index at the end, MKVs their cues.

The server listens on loopback only, and answers only with the 128-bit secret in the path, for the torrent playing, and when the `Host` is a loopback address, so neither another user's process nor a web page that points a name at 127.0.0.1 can read it.

**The file**: the addon's `fileIdx` when the file there has the stream's file name (or there is no name), else the file by that name, else the largest video. Not a video, or none: `no_file`.

## The cache

Pieces go to the OS cache folder (`~/Library/Caches/Peli/torrents`, `~/.cache/Peli/torrents`, `%LOCALAPPDATA%\cache\Peli\torrents`; `$PELI_DATA_DIR/torrents` when that's set), one file per verified piece. A piece being downloaded is `<index>.part` and is renamed when its hash checks. Past the cap, the **oldest written** pieces go first, not the least recently read: a stream reads in order, so promoting a piece on read would drop the pieces fetched ahead of the player, which is exactly what it needs next. A later run finds what an earlier one left, newest first and within the cap, and deletes unfinished pieces. Settings shows the size used and can clear it, but the torrent playing's pieces stay.

The client doesn't download more than the cap at once: it only asks for the readers' windows (16 MB past each) and the four end pieces. When the cache drops a piece the client is told (`Piece.UpdateCompletion`), and a read that finds a piece gone waits up to 30 s for it to come again.

Two things in anacrolix/torrent v1.61 didn't work as documented, and each stalled a test stream for a minute:

- **Its own storage cap** (`TorrentImpl.Capacity`): with one, its request planner stopped asking for pieces until a peer timed out. Peli's cache doesn't give it one.
- **A missed wake-up** in each connection's writer: if the signal to ask for pieces comes between its last look and its wait, it sleeps until its keep-alive timer. That was a minute by default, which stalled about 1 in 25 test streams right after the metadata came. The timer is set to 2 s, so a stall lasts 2 s at most. It costs a 4-byte keep-alive every 2 s to a peer we want something from.

**No SQLite.** anacrolix's `storage` package links a SQLite piece-completion store through `github.com/go-llsqlite/adapter`, a module with no licence, unless built with `-tags nosqlite`. Peli's cache keeps completion itself, so every production build passes `nosqlite` (the three desktop Taskfiles, the server build, bindings, `tools/notices`), and `nosqlite.go` stops a production build that doesn't. Dev and test builds still link it, and nothing ships them. CI checks the tag in the built binary's build info.

## Off until turned on

**Playback › Stream torrents** is off by default, for this device, and says what it means: the file comes from other people, they see the user's IP address, and they get pieces from the user too. `Open` checks it in Go as well (`disabled`). While it's off, picking a torrent says "Torrent streaming is off" with a button to Settings. The cache size row shows only while it's on.

Uploading isn't turned off. Swarms favour peers that give back, and a client that only takes downloads more slowly. It stops when the player closes, as the torrent is dropped then.

## Picking and status

`resolvePick` now tries every copy with a link before any torrent, even when the pick is the torrent: the same file through a debrid service or a direct link starts sooner than peers do. Then at most two torrents, one at a time: a dead one takes 45 s to give up on. Torrent streaming being off ends the torrents at once. The error is still the pick's own, unless the pick was a torrent with streaming off and a copy with a link failed. New messages: `no_peers` "No one is sharing this torrent", `no_file` "This torrent has no video to play", `torrent_failed` "Couldn't start streaming the torrent".

`Status` gives peers, seeders, download and upload rate (bytes a second over the last three seconds), bytes ready past where the player's main connection reads, and bytes done of the file. The picker's "Opening…" toast shows it once a second while a torrent opens ("Getting the file list from 3 peers…"). The player shows "12 peers · 3.4 MB/s · 48 MB ready" at the top and under the spinner while it waits. Leaving the player stops mpv, then lets the torrent go. A torrent's link doesn't expire, so the player never asks an addon for it again.

## As measured

| | |
|---|---|
| Live, Big Buck Bunny (276 MB, 6–15 peers) | File list 3–5 s, first MB 6 s after it, 1.8–5.6 MB/s, a seek to the middle 3.4 s. mpv 0.41 played it from 0:00 and from 5:00 |
| Live, Sintel (129 MB, 5 peers) | File list 12 s, first MB 11 s after it, 0.4 MB/s, a seek 3.6 s |
| The whole film through the engine | Byte for byte the same as the torrent's (276 MB), and 12 concurrent random ranges matched |
| Memory | The whole test process at 34–44 MB RSS (12–16 MB Go heap) while streaming. The client doesn't run until the first torrent |
| Binary | +10.9 MB on macOS arm64 (14.6 → 25.5 MB stripped, built with `nosqlite`), **+3.7 MB gzipped**. Most of it is pion's WebRTC, which anacrolix links even with WebTorrent off, and no build tag removes it |

Those are old, small swarms of Creative Commons films, run with `PELI_TORRENT_LIVE=1 go test -v -run TestLive ./internal/torrent`. A popular release has far more peers. Time to first frame depends on the swarm, so it has no target here. ADR-0005's ≤ 3 s is for debrid links. **Installers:** the per-arch DMGs (8–24 MB) and NSIS installer stay well under 60 MB. The AppImage, about 90 MB with libmpv, comes close to its 100 MB ceiling; #88's check will tell.

## Tests

`internal/torrent` runs a seeder on loopback with no DHT or trackers: the file served whole and from a range, a 4 MB file through a 1 MB cache twice, the refusals (off, a bad hash, no video, no peers, cancelled), only the right secret, torrent and host served, another torrent replacing the first, file picking, trackers from sources and the error codes. The cache has its own: oldest out, the newest kept even over the cap, a reopen, clear keeping what plays. All pass with `-race` on macOS, and on Linux in Docker. Windows was cross-compiled (go-libutp's C++ with mingw-w64), not run.

## Consequences

- **Firewalls.** The client accepts incoming peers, so Windows Defender Firewall asks the first time a torrent streams, and so does macOS's firewall when it's on. The loopback server asks nothing.
- **Windows CI builds C++.** go-libutp (uTP) is C++ through cgo, and builds with the runner's MinGW `g++`. If that turns out to be a problem, `-tags disable_libutp` uses anacrolix's Go uTP instead.
- **No resume of partial pieces across runs.** A `.part` is deleted at startup. Verified pieces are kept, so playing the same file again starts from the cache.
- **Kids profiles** aren't treated differently: the setting is the device's, like hardware decoding.
- Remembering a torrent pick per show (#58) and switching streams in the player (#68) can use `Torrents.Open` as they use resolving.
