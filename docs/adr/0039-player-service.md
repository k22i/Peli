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
| `internal/player/player.go` | `Service`: `Load`, `SetPaused`, `Seek`, `Scrub` (keyframe seek, for dragging; #61), `SeekBy`, `SetVolume`, `SetMuted`, `SetSpeed`, `SetAudioTrack`, `SetSubtitleTrack`, `SetSubtitleDelay`, `SetSubtitleSize` (#62), `SetFullscreen`, `Stop`, `Snapshot`; the event loop |
| `internal/watching/watching.go` | `Reporter` (#64): the player's progress reports become the profile's progress and watched marks, and ask the push loop to send them |
| `internal/player/captions_{darwin,other}.go` | The OS's captions preference (#62): MediaAccessibility on macOS, none elsewhere |
| `internal/player/host.go` | The `host` interface each OS implements, and `nullHost` (no video or audio output) for tests |
| `host_darwin.go`, `video_darwin.m` | macOS: a `CAOpenGLLayer` view below the `WKWebView`, drawn on our own serial queue |
| `host_linux.go`, `video_linux.c` | Linux (X11 and Wayland): `gltex`, textures rendered on our own thread, shown by a `GtkPicture` below the webview |
| `host_windows.go` | Windows: `wid`, mpv's child window at `HWND_BOTTOM`, disabled |
| `frontend/src/lib/player.ts` | `usePlayerState` (snapshot, then events), `usePlayerEnded`, `reloadExpired`, `loadOptions` and `trackLabel` (#62) |
| `frontend/src/components/player/player-page.tsx`, `seek-bar.tsx` | The `/player` screen and its controls (#61) |

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
| `player:state` | `State`: `active`, `loading`, `paused`, `buffering`, `bufferPercent`, `seeking`, `position`, `duration`, `buffered`, `volume`, `muted`, `speed`, `fullscreen`, `tracks`, `hwdec`, `subtitleDelay`, `subtitleSize` (#62) | Whenever anything but the time changes |
| `player:time` | `Time`: `position`, `duration`, `buffered` (seconds of cache ahead) | At most every 250 ms while playing, and at once after the first frame or a seek |
| `player:ended` | `Ended`: `reason` `eof` or `error`; for errors `code` `expired`, `unsupported` or `failed`, and mpv's `message` | The file ended by itself. `Stop` and loading another file send nothing |

Times are in seconds. All three are registered with `application.RegisterEvent`, so the bindings type them. `Snapshot()` returns the same `State`: events sent before a page listens arrive late (3–7 s on Windows CI in M0), so the page reads a snapshot when it mounts and applies events after it.

This merges the spikes' `player:tracks`, `player:buffering` and name/value `player:state` into one `State`. One shape is simpler for React than five, and a burst of property changes (a load sets a dozen) becomes **one** event: the loop handles every event waiting, then sends what changed. `player:time` stays separate and throttled, because a re-render per frame cost ~10 % CPU in WebKit (M0, #4).

**`expired`** comes from FFmpeg's "HTTP error 401/403/404/410" log line. The client has to ask for log messages at `v`: at `warn`, libmpv drops that line. libmpv also sends FFmpeg's log to only one mpv instance per process. The app has one at a time, but the test for it can't run in parallel with the others. On `expired`, the player screen asks the addon's link again (`Resolve(origin)`, ADR-0037) and loads the new one from the position it stopped at, at most once a minute.

## Tracks and subtitles (#62)

`Load` also takes the profile's `audioLanguage` and `subtitleLanguage` (ISO 639 codes, "" for the file's default), `captions` and `subtitleSize`. It sets them as properties before `loadfile`, and mpv picks the tracks. We tried mpv 0.41 on a file with a default-flagged, a second-language and a forced subtitle track (`testdata/tracks.mkv`). These settings give the behaviour we want:

| Captions | mpv | Shows |
|---|---|---|
| on | `sid=auto`, `slang=<language>`, `subs-fallback=yes`, `subs-fallback-forced=no` | Full subtitles in the language, or else the default or first track. Never the forced track when a full one exists |
| off | `sid=auto`, `slang=`, `subs-fallback=no`, `subs-fallback-forced=yes` | Forced subtitles (signs, foreign dialogue) in the audio's language only. `sid=auto` alone shows a default-flagged track when the audio is in another language |
| system | on or off, as the OS asks | |

Every session also sets `subs-match-os-language=no`, so a language left "" means the file's default, not the OS language. Two-letter codes match three-letter tags (`ja` picks `jpn`).

**System** reads MediaAccessibility on macOS: captions are on when the display type is "always on", or when the preferred captioning characteristics include transcribed dialogue ("Prefer closed captions and SDH"). Windows' captions settings only style captions, and Linux desktops have no such setting, so System means off there and the profile's On turns captions on.

The player screen has an Audio menu (two or more tracks: language, codec, channels) and a Subtitles menu (Off and each track, marked Forced, SDH or External; Small/Medium/Large; timing in 0.1 s steps, also on Z and X). The size the user picks is saved as the profile's `subtitleSize`, as Settings saves it. Timing isn't saved: a delay fixes one release's subtitles, and as a profile default it would put every other file out of sync. It lasts for the session, so a retry or a fresh link keeps it. A retry or a fresh link also loads with the languages of the tracks that were playing, so tracks picked by hand stay picked. mpv keeps `sub-delay` as a float32, so the state rounds it to milliseconds.

## Addon subtitles (#63)

The player screen asks every enabled addon that serves `subtitles` for the video (not limited for a kids profile, like streams), with the `filename`, `videoSize` and `videoHash` extras the picked stream gives, which help OpenSubtitles match the release. Subtitles in the stream's own answer come first. The Subtitles menu lists them under "From addons", one submenu per language: the profile's language first, then by name. OpenSubtitles' codes are ISO 639-2 plus a few of its own (`pob` is Brazilian Portuguese), read with `Intl.Locale`.

`Service.AddSubtitle({url, lang, title})` downloads the file in Go (Sinag's User-Agent, 30 s, 16 MiB, gzip unpacked), writes it to a temporary folder kept until the session closes, and runs `sub-add <file> select <title> <lang>`. It returns the new track's id, and the track shows in the menu as External. Go downloads it rather than mpv, because mpv would send the stream's `http-header-fields` (an addon's proxy headers) to the subtitle server too. Loading a file drops its external tracks, so after a retry or a fresh link the screen adds the addon subtitles that were showing again.

When captions are on (or System, and the OS asks for them: `Service.SystemCaptions`) and the file has no full subtitles in the profile's language, the first addon subtitle in that language is added by itself, once per file. Picking subtitles in the menu (the file's own or an addon's, but not forced ones) saves their language as the profile's `subtitleLanguage`, so the next file starts in it. Captions on or off stays a Settings choice: Off in the menu turns subtitles off for this file only.

## Progress, resume and watched (#64)

**Go keeps the progress, not the screen.** `LoadOptions.watching` names the film or episode a file plays (profile, content id and type, video id, season and episode, and the name its watched item takes). `player.ReportTo` hands the service a `Report` (position, duration, why) every `ReportEvery` (10 s) while it plays, when it pauses, lands after a seek, ends by itself (played to the end counts as the whole duration), and when it is stopped or replaced by another `Load`. That covers leaving the screen, and quitting the app: the player shuts down before the syncer, which sends the last report on its way out. A file still loading, or with no known length (live), reports nothing, so a start position asked for is never saved as one reached. We chose Go over a React hook because a quit or a closed window never runs the screen's cleanup, and the position at the moment of stopping is the one the user expects on the other device.

`watching.Reporter` writes each report with `Store.SaveProgress` (ms, a fresh `lastWatched`, Nuvio's key `<id>_s<season>e<episode>`). The push loop already holds progress to one push per entry every 30 s (ADR-0017), so a periodic report only saves. A pause, seek, end or stop also calls `Pusher.FlushProgress`, in the background and one at a time (a burst of seeks becomes one more push), so the position where playback stopped leaves at once, outside the server's 30 s and 15 s thresholds most of the time.

**Watched at 90 %, as the server counts it.** At 90 % of an item of at least a minute the reporter marks it watched (`Store.MarkWatched`), unless it is marked already, so playing on or watching again queues nothing more. That is the server's own rule (M0 gotcha 2): the finished progress makes the server create the same item, so Sinag's mark must not reach it as a second push. `FlushProgress` is the new push mode for this: like a flush it ignores the 30 s hold and the backoff, but a watched upsert still waits out `WatchedGrace` behind its finished progress and is then settled by the pull (ADR-0017). The app's exit flush uses it too, since the outbox outlives the app; only the sign-out flush still sends everything. The progress stays (finished), as the server keeps it, so Continue Watching drops the item by its 90 % rule and the title page counts it watched either way. Files under a minute are never marked, as on the server. A series' own mark isn't touched: the title page derives "series watched" from the episodes, and reconciles the series mark on the next edit there (ADR-0029).

**Resume from the store, as synced.** The stream picker pulls when it opens (Go skips it inside its 30 s throttle), and when a stream is picked it reads the title's progress from the store afresh (`titleProgressQuery`, `staleTime: 0`) rather than trusting the card that opened it: another device may have moved it on. `watchingFor` names the episode from the title's details, else its progress, else its id (`tt…:2:4`); `resumePoint` returns its unfinished position, or 0 at or past 90 %. Only if the store can't answer does the card's `resumeAt` stand. The player screen gets `watching` and `resumedAt` in history state, passes `watching` to every `Load` (retries and fresh links too), and, for a file that resumed, shows "Resumed at 23:14 · Start over" for its first 10 s of playing; Start over seeks to 0, which the next report saves. Leaving the screen invalidates the progress and watched queries once `Stop` has returned, by which time Go has saved where it stopped.

A guest's reports and marks stay local: the store queues no push for an unlinked profile, so the flushes send nothing (`TestGuestReportsMakeNoNuvioRequests`, #23's check for playing and resuming).

## The hosts, as run

- **macOS** (M1 Pro, macOS 27, Homebrew libmpv 0.41): video under the webview, letterboxed, with the React page on top. Resize, fullscreen on the external display and back, pause, stop and 20 reloads all fine. The layer never draws on the main thread: `needsDisplayOnBoundsChange` is off, and a resize or a backing-scale change (another display) asks our queue to draw. If Core Animation asks on the main thread anyway, it gets black and a redraw from the queue. While playing, an `NSProcessInfo` activity keeps App Nap and display sleep away. `drawsBackground` is turned off on the `WKWebView` by hand (Wails beta.28 leaves it on) and restored on `Stop`.
- **Linux** (Debian 13 container, GTK 4.18, libmpv 0.40, llvmpipe: no GPU): video under the webview on X11 (Xvfb + openbox + picom) and Wayland (headless sway), resize fine, `Stop` takes the thread count back each time. The picture is made once and hidden between sessions, and the webview's background is made transparent and restored in C. A slot release that arrives late, from GTK's previous session, carries an old generation and is ignored, or it would free a texture GTK is showing. **Not settled:** at 1080p60 in software, some frames showed llvmpipe's tile grid (a texture sampled mid-render), on X11 from the second session and once on Wayland. One Wayland run showed a black video plane under working subtitles. At 720p30 all were clean. That points at CPU starvation in the container more than at the host, but #91 must check it on a real GPU desktop, together with the X11 host choice.
- **Windows**: compiled (mingw-w64 cross-build, `go vet`) but **not run**: no Windows machine, and GitHub Actions was down. The host follows #2/#3: `vo=gpu-next` pinned, `wid` set to the window's HWND, and on every `vo-configured` (mpv recreates its window on a VO re-init) its window goes to `HWND_BOTTOM` and is disabled. The webview is made transparent through Wails' `SetBackgroundColour` (WebView2 takes alpha 0 or 255 only), and the frontend repaints the theme colour when the player closes, since Wails has no getter for it.

## Consequences

- Every build links libmpv. Until #92's pinned LGPL builds exist, CI links the distro's (Linux), Homebrew's (macOS) and shinchiro's (Windows, the spikes' build), and nothing bundles it. Windows builds with cgo now (`CGO_ENABLED` defaults to 1 in its Taskfile).
- Keeping the screen awake on Linux and Windows isn't done: their `playing` hooks are empty.
- A watched mark held at exit is in the outbox after the next launch, but the grace lives in memory: if the launch push runs before the launch pull, it goes out and repeats the server's item. That needs quitting within 75 s of crossing 90 %, which for a film or an episode lands in the credits or before them.
- The controls are #61's: seek bar (buffered range, hover time, scrub while dragging, exact seek on release), play/pause, ±10 s, volume, fullscreen, title and episode, auto-hide with the cursor, buffering and error overlays. What the user sets shows at once and waits for the state to catch up (`useAhead`, 3 s at most); seeks and volume changes go one at a time, newest next (`latestOnly`).
