---
status: accepted
date: 2026-10-30
---

# Resolving a picked stream: one ranged request through Go, the pick and then its copies, notices read by name

#53 turns a pick from the stream picker ([ADR-0036](0036-stream-picker.md)) into what the player (#60) loads: an addon's direct HTTP or debrid link, followed through its redirects to the file, with the headers the addon asks for. Debrid addons don't always send a file. When the service doesn't have it yet, or refuses the account, they redirect to a short notice video, and links to a service's files expire. Each of those needs a clear message, not a player that plays a "downloading" clip.

## Layout

| File | |
|---|---|
| `internal/streams/service.go` | `Service.Resolve(Request) → Source`: the request, the checks, the error codes |
| `lib/resolve.ts` | `resolvePick(candidate, …)`: the pick, then its alternates; asking again on an expired link; the messages |
| `components/streams/streams-page.tsx` | `pick` resolves, with one toast that goes from "Opening…" to the outcome |
| `tools/ttff/` | Time to first frame through mpv on a capped line (below) |

## In Go, not the webview

The webview's fetch can't set `User-Agent`, can't see where redirects led, and is subject to CORS, which debrid CDNs don't send. `Resolve` makes **one GET with `Range: bytes=0-0`**: the headers are enough to learn the file's type and size. It sends the addon's `behaviorHints.proxyHeaders.request` on every hop. An addon's `User-Agent` replaces Peli's. Headers the player sets itself (`Range`, `Host`, …) and invalid ones (a newline in a value) are dropped.

Go's client sends the previous URL as the `Referer` on each redirect. For Torrentio that URL is `/resolve/torbox/<key>/…`, so the next host would get the user's debrid key. The client strips that header unless the addon set one, and a test checks that no hop sees the key.

The `Source` it returns has the **final URL** (the CDN link), the **origin** (the addon's URL), the headers, the user agent, the media type and the size. Loading the final URL skips the redirects a second time: about 1.7 s with Torrentio and TorBox cold. If the CDN link expires during playback, #60 resolves `origin` again. `HeaderFields()` gives the headers as mpv's `http-header-fields`, to be set as a list, since a value can hold a comma.

## What isn't a file

Recorded against Torrentio with TorBox: a cached file goes resolve URL → 302 → TorBox `requestdl` → 307 → CDN → 206 with the whole size in `Content-Range` (7.4 GB). A file TorBox doesn't have goes resolve URL → 302 (4.8 s, while Torrentio adds the torrent to TorBox) → `/videos/downloading_v3.mp4`, 118,743 bytes.

| Answer | Code |
|---|---|
| 401, 403, 404, 410 at the end of the redirects | `expired` |
| 429 | `busy` |
| 5xx | `unavailable` |
| `text/html`, `application/json`, other text | `not_video` |
| A video of 16 MiB or less | a notice: `caching`, `denied`, `busy` or `failed`, by its file name |
| More than 10 redirects | `redirects` |
| Transport failure / 30 s | `unreachable` / `timeout` |

HLS and DASH manifests (by media type, or `.m3u8` / `.mpd`) are small text but playable, so they pass. **A notice is read by its name**, in this order: `limit` → busy; `access`, `api_key`, `auth`, `blocked`, … → denied; `fail`, `error`, `rar`, `infring`, … → failed; `download`, `cach`, `queue`, … → caching. That covers Torrentio's `failed_access_v2.mp4` (denied, not failed) and MediaFusion's `torrent_not_downloaded.mp4` (caching). A notice with any other name is `failed`. Size is the gate, because no film or episode is 16 MiB. Errors are codes only (`MarshalError`). No error or log names a URL.

## The pick, then its copies

`resolvePick` tries `candidate.stream`, then each of `candidate.alternates` (the same file from another addon or torrent), one at a time: resolving can make the debrid service start a download, so copies aren't raced. A stream without a link is skipped: a torrent is the torrent engine's (#55), and a YouTube id or external link isn't playable. **The error is the pick's own**, since the copies are only fallbacks, unless the pick was a torrent and a copy with a link failed, which says more.

On `expired`, the addon is asked again once (`fetchQuery` with `staleTime: 0`, since stream answers are kept up to 30 minutes). The same stream is found in the new answer by the ranking engine's `dedupKey` (torrent and file), else by name, text and file name, and its new link is resolved. The picker's ranked list isn't re-fed (ADR-0034); the next visit ranks the new answer.

Messages name the debrid service when the stream says which: "TorBox is still downloading this · It isn't cached there yet. Pick a cached stream to watch now, or try this one again in a few minutes." A second pick replaces the first, and leaving the picker cancels the Go call (the Wails call's `cancel`, which cancels the request's context).

## Time to first frame

`tools/ttff` asks Torrentio with TorBox, resolves through `internal/streams`, serves the file to mpv 0.41 through a loopback proxy capped at 50 Mbit/s, and times pick → `playback-restart`. mpv is already idle (as libmpv will be), with a null VO and `hwdec=auto-copy`, and gets the Source as #60 will: `user-agent`, `http-header-fields`, then `loadfile`. It played only torrents already in the TorBox account, because resolving one that isn't adds it there. Measured on an M1 Pro, with TorBox's APAC CDN:

| | Pick → first frame |
|---|---|
| A file's first play (19 files) | median **3.3 s**, 4 under 3 s, worst 5.4 s |
| The same file again | 0.7–1.4 s |
| First play without the cap (2 files) | 3.5 s, 3.9 s |

The resolve takes 1.8–2.7 s of that when cold, mostly on Torrentio's and TorBox's servers. Peli's own check of the file costs one CDN round trip (170–200 ms). mpv's open takes 0.9–3.2 s, slowest for MP4s (about 5 MB read before the first frame). Bandwidth isn't the limit. **The ≤ 3 s target isn't met on a first play.** #101 holds it: re-measure with #60's libmpv, and decide whether to resolve a cached top pick before it's picked. That would save about 2 s, but it adds the torrent to the user's debrid list without being asked.

## Not done here

The player (#60) loads the `Source`. Until it does, a resolved pick says the player isn't built. Debrid accounts of the app's own (#54) aren't needed: in every addon recorded, the addon resolves debrid itself. Torrents are #55.
