---
name: seek-previews
description: "2026-11-24 seek-bar preview spike: second headless libmpv (vo=null, keyframe seeks, request_size=1 MiB), ~0.5 s and 2–4 MB per thumbnail; one TorBox node refused connections after a burst of 256 KiB requests (others fine); Seekr rejected as primary"
metadata:
  type: project
---

Spike in `docs/spikes/seek-previews.md` + `spikes/seek-previews/`. Verdict: Peli makes previews itself, on hover plus a small coarse fill, for HTTP/debrid only (torrents off). Seekr (TMDB/IMDb-keyed sprites, one person's free service, per-user key, sees what you watch) is at most an opt-in fallback.

**Why:** measured on a 75 GB TorBox remux: 1.3 s with mpv's open-ended reads, 0.48 s with `stream-lavf-o=request_size=1048576`; VideoToolbox-copy decodes a 4K keyframe in ~70 ms; `screenshot-raw` works with `vo=null`; PQ frames need the Go tone map in `tonemap.go`.

**How to apply:**
- **Never burst small range requests at a debrid CDN.** 256 KiB requests (~400 in a minute) made TorBox node 50.7.60.34 stall and then refuse connections for 30+ minutes (node down or refusing this client). Only that node: Peli kept playing from 50.7.60.26 meanwhile, so it wasn't an IP or account block. Keep live runs at ≥ 1 MiB, one at a time, spaced out, and back off on errors.
- Unchecked: Dolby Vision profile 5 colours, iOS, Windows, main-player frame drops.
- Related: [[player-service]], [[stream-resolve]], [[debrid-test-key]], [[torrent-streaming]], [[subtitle-autosync]].
