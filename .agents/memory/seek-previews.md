---
name: seek-previews
description: "2026-11-24 seek-bar preview spike: second headless libmpv (vo=null, keyframe seeks, request_size=1 MiB), ~0.5 s and 2–4 MB per thumbnail; one TorBox node refused connections after a burst of 256 KiB requests (others fine); Seekr rejected as primary"
metadata:
  type: project
---

Spike in `docs/spikes/seek-previews.md` + `spikes/seek-previews/`. Verdict: Peli makes previews itself, on hover plus a small coarse fill. **Debrid streams only** (user's decision 2026-11-24: no torrents, no plain HTTP links). The source may be a smaller **cached** release on the same debrid service, used only if its duration is within **±2 s** of the playing file (decided from data: gaps of a minute or more were sometimes credits-only and sometimes cuts through the film, e.g. "Cropped" AV1 encodes); otherwise the playing file. Seekr (TMDB/IMDb-keyed sprites, one person's free service, per-user key, sees what you watch) is at most an opt-in fallback.

**Why:** measured on a 75 GB TorBox remux: 1.3 s with mpv's open-ended reads, 0.48 s with `stream-lavf-o=request_size=1048576`; VideoToolbox-copy decodes a 4K keyframe in ~70 ms; `screenshot-raw` works with `vo=null`; PQ frames need the Go tone map in `tonemap.go`.

**How to apply:**
- **Never burst small range requests at a debrid CDN.** 256 KiB requests (~400 in a minute) made TorBox node 50.7.60.34 stall and then refuse connections for 30+ minutes (node down or refusing this client). Only that node: Peli kept playing from 50.7.60.26 meanwhile, so it wasn't an IP or account block. Keep live runs at ≥ 1 MiB, one at a time, spaced out, and back off on errors.
- **Built 2026-11-24 (local main, not pushed):** Go `internal/previews` (Service Begin/At/End bound to the frontend, Grabber/Opener seam, 10 s buckets, latest-only tickets, ±2 s smaller-copy check, 2-failure stop, 30 s idle close, coarse fill emitting `previews:thumb`, tonemap.go, thumb.go JPEG data URLs); `player.OpenPreview` / `iosplayer.OpenPreview` (headless mpv, auto-copy / videotoolbox-copy, never `requestLogMessages`: the player owns the one FFmpeg log); `openPreview` var in main_desktop.go/main_ios.go. Frontend `lib/previews.ts` (`isPreviewable` debrid-only, `smallerCopies` ≥ 5 GB playing / cached same debrid / no AV1 / no packs / SDR first, `useSeekPreviews` with keyed state), SeekBar `preview`/`onPreviewWant`, ScrubLabel `thumb` on touch, DeviceSettings `seekPreviews` (on) / `previewsFromSmaller` (off) in Settings. No fill on iOS. `@bindings/previews` mock in test/setup.ts.
- A new DeviceSettings field breaks six test files that spell the type out in full (streams.test.ts, downloads-entry/-playback, player ×2, streams.test.tsx): add it there too.
- The full frontend suite sometimes ends with an unhandled `ECONNREFUSED localhost:3000` (jsdom's origin), 2 of 6 runs on 2026-11-24, not from previews (its tests are clean alone).
- Unchecked: Dolby Vision profile 5 colours, iOS on a device, Windows, main-player frame drops, a live in-app run over TorBox.
- Related: [[player-service]], [[stream-resolve]], [[debrid-test-key]], [[torrent-streaming]], [[subtitle-autosync]].
