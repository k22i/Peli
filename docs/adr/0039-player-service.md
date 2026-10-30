---
status: accepted
date: 2026-10-30
---

# The player service: one mpv session per playback, three events, a host per OS

#60 builds what ADR-0001 and ADR-0002 decided: libmpv in-process, with its video under the transparent webview in the app window. This ADR records the shape of the Go service, the event contract the React controls (#61) build on, and what the first real runs of each host showed.

## Layout

| File | |
|---|---|
| `internal/player/mpv.go` | The cgo binding to `mpv/client.h`, from the spikes. A live-handle count for tests |
| `internal/player/player.go` | `Service`: `Load`, `SetPaused`, `Seek`, `SeekBy`, `SetVolume`, `SetMuted`, `SetSpeed`, `SetFullscreen`, `Stop`, `Snapshot`; the event loop |
| `internal/player/host.go` | The `host` interface each OS implements, and `nullHost` (no video or audio output) for tests |
| `host_darwin.go`, `video_darwin.m` | macOS: a `CAOpenGLLayer` view below the `WKWebView`, drawn on our own serial queue |
| `host_linux.go`, `video_linux.c` | Linux (X11 and Wayland): `gltex`, textures rendered on our own thread, shown by a `GtkPicture` below the webview |
| `host_windows.go` | Windows: `wid`, mpv's child window at `HWND_BOTTOM`, disabled |
| `frontend/src/lib/player.ts` | `usePlayerState` (snapshot, then events), `usePlayerEnded`, `reloadExpired` |
| `frontend/src/components/player/player-page.tsx` | The `/player` screen: the bare minimum until #61 |

## A session is one mpv handle

`Load` opens a session if none is open: `mpv_create`, the options, the host's options (`vo`, `wid`), `mpv_initialize`, the property observers, the event loop, then the host's surface and render context, **before the first `loadfile`**. A second `Load` replaces the file in the same session (`loadfile … replace`). `Stop`, leaving the player screen and app shutdown close it in the order the M0 binding rules give: a flag, `mpv_wakeup`, join the event loop, free the render context on the render thread, remove the surface on the UI thread, then `mpv_terminate_destroy`.

We chose one handle per playback over one for the app's life: nothing of mpv's lingers between films, a broken state can't carry over, and the "no leaked handles" check is a counter that must read 0. Opening costs single-digit milliseconds (M0, #3). A test opens and closes 10 sessions and checks the handle count and the goroutines. On macOS 22 sessions in the app brought the thread count back to its idle value each time.

No libmpv call runs on the UI thread. Bound methods run on Wails' goroutines, the hosts move only their widget work onto the UI thread, and every render call happens on a render thread or queue of our own.

## Loading a stream

`Load(source, {start})` takes the `Source` that resolving returns (ADR-0037). It sets `user-agent` (the addon's or Sinag's) and `http-header-fields` **as a list** (`mpv_node` array), since a header value may hold a comma. `start` is a per-file `loadfile` option. HLS segments get the same headers: a test serves a playlist and its segments only to requests that carry them.

Every session sets: `idle`, `force-window=no` (with `vo=libmpv`, a forced window would start a VO before the render context exists), `keep-open=no`, no OSC, OSD, scripts or `ytdl` (no youtube-dl subprocess for an HTTP link), no mpv input handling (the webview gets every click and key), `hwdec=auto-safe`, black background. `$SINAG_MPV_OPTIONS` (`"gpu-sw hwdec=no"`) overrides them, for debugging and for GPU-less CI and containers.

## The event contract

| Event | Payload | When |
|---|---|---|
| `player:state` | `State`: `active`, `loading`, `paused`, `buffering`, `bufferPercent`, `seeking`, `position`, `duration`, `buffered`, `volume`, `muted`, `speed`, `fullscreen`, `tracks`, `hwdec` | Whenever anything but the time changes |
| `player:time` | `Time`: `position`, `duration`, `buffered` (seconds of cache ahead) | At most every 250 ms while playing, and at once after the first frame or a seek |
| `player:ended` | `Ended`: `reason` `eof` or `error`; for errors `code` `expired`, `unsupported` or `failed`, and mpv's `message` | The file ended by itself. `Stop` and loading another file send nothing |

Times are in seconds. All three are registered with `application.RegisterEvent`, so the bindings type them. `Snapshot()` returns the same `State`: events sent before a page listens arrive late (3–7 s on Windows CI in M0), so the page reads a snapshot when it mounts and applies events after it.

This merges the spikes' `player:tracks`, `player:buffering` and name/value `player:state` into one `State`. One shape is simpler for React than five, and a burst of property changes (a load sets a dozen) becomes **one** event: the loop handles every event waiting, then sends what changed. `player:time` stays separate and throttled, because a re-render per frame cost ~10 % CPU in WebKit (M0, #4).

**`expired`** comes from FFmpeg's "HTTP error 401/403/404/410" log line. The client has to ask for log messages at `v`: at `warn`, libmpv drops that line. libmpv also sends FFmpeg's log to only one mpv instance per process. The app has one at a time, but the test for it can't run in parallel with the others. On `expired`, the player screen asks the addon's link again (`Resolve(origin)`, ADR-0037) and loads the new one from the position it stopped at, at most once a minute.

## The hosts, as run

- **macOS** (M1 Pro, macOS 27, Homebrew libmpv 0.41): video under the webview, letterboxed, with the React page on top. Resize, fullscreen on the external display and back, pause, stop and 20 reloads all fine. The layer never draws on the main thread: `needsDisplayOnBoundsChange` is off, and a resize or a backing-scale change (another display) asks our queue to draw. If Core Animation asks on the main thread anyway, it gets black and a redraw from the queue. While playing, an `NSProcessInfo` activity keeps App Nap and display sleep away. `drawsBackground` is turned off on the `WKWebView` by hand (Wails beta.28 leaves it on) and restored on `Stop`.
- **Linux** (Debian 13 container, GTK 4.18, libmpv 0.40, llvmpipe: no GPU): video under the webview on X11 (Xvfb + openbox + picom) and Wayland (headless sway), resize fine, `Stop` takes the thread count back each time. The picture is made once and hidden between sessions, and the webview's background is made transparent and restored in C. A slot release that arrives late, from GTK's previous session, carries an old generation and is ignored, or it would free a texture GTK is showing. **Not settled:** at 1080p60 in software, some frames showed llvmpipe's tile grid (a texture sampled mid-render), on X11 from the second session and once on Wayland. One Wayland run showed a black video plane under working subtitles. At 720p30 all were clean. That points at CPU starvation in the container more than at the host, but #91 must check it on a real GPU desktop, together with the X11 host choice.
- **Windows**: compiled (mingw-w64 cross-build, `go vet`) but **not run**: no Windows machine, and GitHub Actions was down. The host follows #2/#3: `vo=gpu-next` pinned, `wid` set to the window's HWND, and on every `vo-configured` (mpv recreates its window on a VO re-init) its window goes to `HWND_BOTTOM` and is disabled. The webview is made transparent through Wails' `SetBackgroundColour` (WebView2 takes alpha 0 or 255 only), and the frontend repaints the theme colour when the player closes, since Wails has no getter for it.

## Consequences

- Every build links libmpv. Until #92's pinned LGPL builds exist, CI links the distro's (Linux), Homebrew's (macOS) and shinchiro's (Windows, the spikes' build), and nothing bundles it. Windows builds with cgo now (`CGO_ENABLED` defaults to 1 in its Taskfile).
- Keeping the screen awake on Linux and Windows isn't done: their `playing` hooks are empty.
- The controls are #61's. `/player` only pauses (click or Space), goes fullscreen (double click), and leaves (Back, Esc or the end).
