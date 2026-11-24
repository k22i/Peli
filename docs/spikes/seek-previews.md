# Spike: seek-bar previews

Date: 2026-11-24 · Spike code: [`spikes/seek-previews/`](../../spikes/seek-previews/) (throwaway). Results: [`spikes/seek-previews/results/`](../../spikes/seek-previews/results/).

Question: can the player show a thumbnail over the seek bar (not frame-exact, one every N seconds is fine), and if Peli can't make them itself, is a service like [Seekr](https://seekr.tv) the way?

## Verdict

**Go: Peli makes them itself, from the stream that's playing, on demand.** A second libmpv on the same link (headless, paused, keyframe seeks) returns a 320-pixel thumbnail in about half a second over a debrid CDN, with the picture always matching the release being watched. It must be gentle with the CDN: one connection, 1 MiB requests, thumbnails made when the seek bar is hovered (plus a small, slow fill), never a 10-second grid of a whole remux.

**Seekr: not as the main source.** It works, but it is keyed by TMDB/IMDb id rather than by file, so it's made from one release and is off by a constant amount on others. Every user needs their own key, it's one person's free side project ("may break, change or shut down at any time"), and every lookup tells it what the user is watching. At most it's an opt-in fallback for torrents, where Peli shouldn't seek a second reader (below).

## What was measured

M1 Pro, our LGPL libmpv (`build/libmpv`, mpv 0.41, FFmpeg 9.0.2). The tool goes through a loopback proxy that counts each thumbnail's requests and bytes.

| Source | Request size | Median | p90 | Per thumbnail |
|---|---|---|---|---|
| Dune 2160p Remux HEVC HDR (75 GB), TorBox CDN | open-ended (mpv's default) | 1.3 s | 1.7 s | 3.7 MB |
| same | 512 KiB | 0.67 s | 1.4 s | 3.4 MB |
| same | **1 MiB** | **0.48 s** | **0.60 s** | 3.6 MB |
| same | 2 MiB | 0.47 s | 0.62 s | 3.7 MB |
| Sintel 1080p MKV, Blender's CDN (89 thumbs, every 10 s) | open-ended | 1.6 s | **12.8 s** | 1.9 MB |
| same | **1 MiB** | **0.75 s** | **1.6 s** | 2.0 MB |
| Local 4K HEVC 10-bit, software decode | 1 MiB | 0.24 s | 0.25 s | n/a |
| same, `videotoolbox-copy` | 1 MiB | **0.07 s** | 0.09 s | n/a |

- **The request size is what matters.** mpv's HTTP reads are open-ended (`bytes=N-`), so after each seek the old response keeps streaming until it is torn down, and the next request waits behind it. FFmpeg's `request_size` (`stream-lavf-o=request_size=1048576`) bounds each read: latency halves and the long tail goes away (p90 12.8 s → 1.6 s on Sintel).
- **About 2–4 MB per thumbnail is inherent.** It's the keyframe plus the frames the decoder wants before it hands one out, and smaller demuxer limits didn't lower it. A 10-second grid of a 2.5-hour remux would be ~930 thumbnails and ~3.3 GB, so a whole-film grid is out for remuxes. On-demand plus a coarse fill isn't: 100 thumbnails is ~350 MB on a remux and ~200 MB on a 1080p encode.
- **Decoding is cheap next to the network.** VideoToolbox in copy mode (the headless mpv has no GPU output) decodes a 4K HEVC keyframe in ~70 ms, against ~240 ms in software.
- **HDR needs tone mapping, and Go can do it.** `screenshot-raw` returns PQ/HLG BT.2020 pixels. A 30-line Go pass (PQ → linear → BT.709 → Reinhard → sRGB) on the 320×180 image looks right (`tonemap.go`, checked on the Dune remux). **Not checked:** Dolby Vision profile 5 (no HDR10 base layer, e.g. many streaming WEB-DLs) will come out green and purple without libplacebo. Find out what `video-params` reports for those, and leave previews off for them if there's no cheap fix.
- **Burst size matters to the CDN.** With 256 KiB requests (8–17 per thumbnail, ~400 requests in under a minute) the TorBox node stalled one request for 30 s and then **refused all connections from this Mac**. It still refused 30+ minutes later, and new `requestdl` links for that file pointed at the same IP. Other TorBox nodes kept working from the same Mac: Peli was playing from 50.7.60.26 the whole time. So it was one node, either down or refusing this client, not a block on the account or the IP ([`dune-request-size.txt`](../../spikes/seek-previews/results/dune-request-size.txt)). Still, the design has to keep requests few and large, run one at a time, and back off on errors. If a node did block a client over previews, it would also cut off playback of every file on that node.

`vo=null` works for `screenshot-raw` (the frame comes from the decoder, not a renderer), so the second mpv needs no window, render context or GPU output.

## Resource use

Measured on the M1 Pro with the spike process (`/usr/bin/time -l`, local 4K HEVC 10-bit file, 60 thumbnails). The numbers include the spike's own Go buffers, so they're upper bounds:

| | CPU per thumbnail | Peak memory |
|---|---|---|
| `videotoolbox-copy` | ~30 ms | ~210 MB open, ~250 MB after 60 |
| software decode | ~500 ms (4 cores busy ~0.25 s) | ~300–370 MB |

- **Memory scales with the source's resolution, not with the thumbnails:** peak footprint was 30 MB for a 320×180 clip, ~43 MB for 1080p (H.264 or HEVC 10-bit) and ~214 MB for 4K (2 thumbnails each, `videotoolbox-copy`). That's the decoder's 4K frames (~24 MB each) copied off the GPU.
- **What didn't shrink it:** `hwdec-extra-frames=0`, `vd-queue-enable=no`, `demuxer-max-bytes=1MiB` and `vd-lavc-threads=1` all left 4K with VideoToolbox at ~248 MB (30 thumbnails). With software decoding, `vd-lavc-threads=1` does help (362 → 239 MB, 228 → 287 ms each).
- **Scaling on the GPU isn't possible as things stand:** our FFmpeg build has no `scale_vt` (`CONFIG_SCALE_VT_FILTER 0`). And a headless mpv (`vo=null`) can't create a VideoToolbox device ("Could not create device"), so only copy mode works and full-size frames always reach main memory. The way round it is to decode outside mpv (our own demux, then a `VTDecompressionSession` that outputs 320-pixel buffers), which is a project of its own.
- **What does work:** keep the second mpv open only while it's needed (open on scrub, close ~30 s after the last request, so the memory goes away between scrubs); one at a time; on macOS optionally a helper process, so the memory is fully released and a crash can't touch playback; close it on memory pressure (`UIApplicationDidReceiveMemoryWarning`, a `DISPATCH_SOURCE_TYPE_MEMORYPRESSURE` source); and, later, make previews from a 1080p release of the same title (~43 MB instead of ~214 MB, and fewer bytes per thumbnail; see the alternatives below).
- The spike's `-opts "name=value …"` passes extra mpv options for trying more of these.
- A coarse fill of 100 thumbnails is ~3 s of CPU in total, spread over minutes. The thumbnails are ~10 KB each, so 1 MB for 100 and ~9 MB for a 10-second grid of a whole film. Network is the real cost: 2–4 MB per thumbnail.
- **iOS (not measured):** expect a similar ~200 MB on a device with VideoToolbox, on top of the player. This is the main risk there (jetsam), so open it only on scrub, close it soon after, and never run it while the app is in the background. No fill on cellular or in Low Data Mode, because the radio costs more battery than the decoding. Keep the thumbnails out of the webview's memory (asset URLs, a small cap), given the WebContent kills in #128.

## A smaller release as the thumbnail source

Asked after the first pass: make the previews from the smallest release of the same title instead of the one playing.

- **The very smallest is often a different cut.** In the subtitle spike's corpus (durations from its `refs/`), the smallest release ran 160 s long (Slow Horses 1.0 GB), 61 s short (Thunderbolts 1.5 GB) or 240 s short (Black Panther "Cropped" AV1). Picking by size alone gives wrong thumbnails.
- **The smallest one with the same duration (±1 s) is usually right.** 34 of 56 releases had a smaller release of the same length: a median 2.9× smaller, up to 92×. The corpus was picked for several releases per title, but a real stream list usually has more. Same length within 1 s held in every pair looked at here, with the same frame at the same time: *Nobody Wants This* S03E01 at 0.7 GB 1080p SDR and 3.7 GB 2160p DV/HDR give identical sheets.
- **Cost (20 thumbnails each, TorBox, `videotoolbox-copy`, 1 MiB requests):** Dune 2.3 GB 2160p: 418 ms median, **0.87 MB** per thumbnail (the 75 GB remux: 3.6 MB). *Nobody Wants This* 0.7 GB 1080p: 428 ms, **0.98 MB** (its 3.7 GB 4K release: 1.7 MB). Time hardly changes, since it's mostly round trips. Data drops 2–4×, and memory drops to ~43 MB when the small release is 1080p (~214 MB at 4K).
- **Side benefits:** an SDR source needs no tone mapping and sidesteps the Dolby Vision profile 5 question.
- **Costs:** the duration is only known once the file is open, so check it before using a candidate (~1–2 s, a few hundred KB), and fall back to the playing file on a mismatch. With Torrentio + TorBox, resolving another release **adds it to the user's TorBox list**, and if it isn't cached, starts a download. So only use candidates marked cached, or links that need no resolving, and say so in the setting. Series packs need the right file inside the pack (the picker already does this).

How Peli would pick it: from the streams already fetched for the picker (`useStreams`, ranking's parsed size and resolution), take the smallest **cached** HTTP candidate at 720p or above, with H.264 or HEVC (M1 has no AV1 hardware decoding) and SDR preferred. Open it in the preview mpv, check its duration against the player's (±1 s) and use it, or try the next one, then fall back to the playing file. It's worth it for remuxes and big 4K files. When the playing file is already small (under ~5 GB), just use it.

## What Peli builds from this

**Go: `internal/previews`** (desktop first, the same code on iOS later):

- One headless mpv per playing file, opened on the first hover (not at load): `vo=null`, `ao=null`, `aid=no`, `sid=no`, `pause`, `hr-seek=no`, `hwdec=videotoolbox-copy` (auto-copy on Windows), `vd-lavc-skiploopfilter=all`, `cache=no`, `demuxer-readahead-secs=0`, `vf=scale=w=320:h=-2`, `stream-lavf-o=request_size=1048576`. It uses the same `Source` as the player (URL, headers, user agent), and on `expired` re-resolves the same way.
- `Previews.At(t)`: rounds to a 10-second bucket, serves it from the cache or queues it. The queue runs one at a time and **latest-only**: a hover that has moved on cancels what's queued. A thumbnail is a JPEG (~10 KB) cached in memory for the file, and optionally on disk keyed by the resolved file, so a rewatch or resume costs nothing.
- Sent as an event (`previews:ready {bucket, dataURL}`) or fetched through the asset server, whichever is lighter in Wails.
- **Coarse fill:** after 30 s of steady playback, fill in "coarse" order (every prefix spans the film: the halves, then the quarters, …) at one thumbnail per ~2 s, pausing while the player buffers. Cap it at ~100 thumbnails or a byte budget, and skip it on cellular on iOS and when Low Data Mode is on.
- **Free thumbnails from what's played:** the main player can take one every 10 s of playback (`screenshot-raw` as auto-crop does), so seeking back over watched parts costs no data. Check first that a 4K readback every 10 s drops no frames.
- **Back-off:** a 429, refused connection, timeout or two failures in a row stops the previews for that file (no retries against a CDN that is pushing back). The player is unaffected.
- **Torrents: off.** A second reader seeking across the file makes anacrolix fetch those pieces from the swarm, competing with playback and churning the FIFO cache. Previews there could come later from pieces already downloaded, or from an opt-in Seekr key.

**Frontend:** over the seek bar on hover and while dragging, show the nearest thumbnail already made at once (dimmed if it isn't the bucket asked for), then swap in the right one. Show the time either way, so there's no empty box when previews are off or failed. On iOS show it above the scrub (#131's `scrubTo`). Seeking still goes to the exact time the user picked, not the keyframe.

**Also cheap to support:** a stream's own `thumbnails` WebVTT (a sprite with `#xywh`), proposed for Stremio addons in [stremio-web #1183](https://github.com/Stremio/stremio-web/pull/1183). If an addon sends one, use it instead of making them.

## Alternatives looked at

| | How | For | Against |
|---|---|---|---|
| **Peli makes them (chosen)** | second headless libmpv, keyframe seeks | always the right release, no account, no third party, works for any HTTP link | 2–4 MB and ~0.5 s per thumbnail; must be rate-limited; DV P5 unchecked |
| **[Seekr](https://seekr.tv)** | API by TMDB/IMDb id (+ season/episode) → 320×180 sprite sheets every 10 s + WebVTT; [Android SDK](https://github.com/AKhalil609/seekr-android-sdk) | instant, no stream data; used by NuvioTV forks | one release per title, so a constant offset on others (their SDK subtracts the duration difference as a guess); per-user API key; one person's free side project that can shut down without notice; sends what you watch (ids, titles, durations) to a third party |
| **Thumbnails from what's played** | capture during playback | zero data | only covers what's been watched; best as an add-on to the chosen path |
| **A smaller release of the same title** | make previews from a 1–2 GB encode instead of the remux (what [NuvioMobile-Reshaped](https://newreleases.io/project/github/DavidVamaiotu/NuvioMobile-Reshaped/release/0.5.2-beta-autosync.1) does) | far fewer bytes per thumbnail | needs a second resolve (adds the torrent to the user's debrid list), Seekr's offset problem between releases, more moving parts. Revisit if data use is a complaint |
| **Addon-provided sprites** | stream `thumbnails` WebVTT | free when present | almost no addon sends them yet |
| **Server-side (Jellyfin trickplay, Plex BIF)** | the server pre-renders sprite files | | Peli has no server and no library of files |

## How this was tested

`go run .` in `spikes/seek-previews` (needs `PKG_CONFIG_PATH` for `build/libmpv/.work/libmpv-macos-arm64/lib/pkgconfig` and an rpath to it in `CGO_LDFLAGS`):

- `-torbox <key>` takes a release from the subtitle spike's corpus (files already in the user's TorBox account, read-only links; nothing added) and needs `TORBOX_API_KEY` from `spikes/stream-ranking/.env`.
- `-url`, `-file` for anything else. `-every`, `-max`, `-order coarse`, `-chunk` (request_size), `-queue` (demuxer-max-bytes) and `-hwdec` are the knobs. It writes a JSON per run and a sprite sheet to `out/`.
- Keep `-chunk` at 1 MiB or more against debrid CDNs, and space runs out (see the block above).

Not done: VideoToolbox runs over TorBox (the node was refusing by then), DV profile 5, Windows, iOS, torrents, and the main player's frame drops while previews load.
