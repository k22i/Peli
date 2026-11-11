---
name: torrent-streaming
description: "#55 torrent engine (ADR-0040): internal/torrent Open/Status/Release + loopback server, cache.go FIFO cap, nosqlite tag on production builds, anacrolix v1.61 stalls and their fixes, live test with CC films; read before #58, #68, #88, #91"
metadata:
  type: project
---

#55 (ADR-0040, 2026-10-30): `internal/torrent` wraps anacrolix/torrent v1.61. `Open(Request{infoHash, fileIdx, fileName, sources}) → streams.Source` with a loopback URL `http://127.0.0.1:<port>/<secret>/<hash>/<file>/<name>` and origin `magnet:…`; `Status` (peers, rates, ahead, done), `Release`, `CacheSize`/`ClearCache`/`SetCacheSize`. Frontend `lib/torrent.ts`; `resolvePick` tries linked copies first, then ≤2 torrents. Off unless `DeviceSettings.TorrentStreaming` (Settings › Playback); `TorrentCacheGB` ∈ {2,5,10,20,50}, default 5.

**Why:** the design choices came from real failures, and repeating them wastes hours.

**How to apply:**
- **Production builds need `-tags production,nosqlite`**: without `nosqlite` anacrolix links go-llsqlite/adapter (no licence). `nosqlite.go` in package main fails such builds on purpose. Taskfiles, bindings, tools/notices and the CI build-info check carry the tag; dev/test builds don't need it.
- Don't give the client `TorrentImpl.Capacity` (its planner stalls), don't evict LRU-on-read (it drops pieces ahead of the player), keep `KeepAliveTimeout` short (2 s) — the writer misses wake-ups and otherwise sleeps 60 s. Each of these showed up as a ~60 s stall in ~1 of 25 test runs; stress with `-count=40 -v` and look at the slowest, not just pass/fail.
- `tools/notices` identify() now checks MPL-2.0 before the GNU licences (MPL names them) and joins wrapped lines.
- Live check (legal content only): `PELI_TORRENT_LIVE=1 go test -v -run TestLive ./internal/torrent` streams Sintel and Big Buck Bunny. Don't test with pirated torrents from real addons.
- mpv's "Invalid NAL unit size" after `--length` is the decoder flushing on exit, not bad bytes (checked against a full copy).
- The binary grew ~+3.7 MB gzipped (pion WebRTC, no tag removes it): relevant to #88's AppImage ceiling.
- Related: [[stream-resolve]], [[player-service]], [[stream-picker]], [[spike-ticket-workflow]].
