---
status: accepted
date: 2026-11-13
---

# The iOS playback engine: libmpv in a GLES view under the webview, hardware decoding chosen per file

Phase 5 of the iOS port (ADR-0055) plays real debrid streams on the iPhone and iPad. The spike (`spikes/ios-libmpv`) showed the path works; this records how it was productionised and what the coverage run found (`docs/ios/playback-coverage.md`).

## What was decided

- **`internal/iosplayer` is the engine** (`//go:build ios`): `Engine` implements `playback.Engine` and is handed to the iOS `player.Service` with `player.UseEngine` (`main_ios.go`); its `playback.Sink` is `player.SinkOf`, so `player:state`, `player:time`, `player:ended` and the progress `Report`s are the desktop's, and `watching`, tracking and the rest of the app don't know which engine plays. Go owns the `mpv_handle` through libmpv's client API (`mpv.go`, the desktop binding trimmed). The only Objective-C is `host_ios.m`: a `CAEAGLLayer` view inserted under Wails' `WKWebView` (found through `window.NativeWindow()` and the controller's `webView` key), the render context, the `.playback` audio session, `idleTimerDisabled` while playing and the captions preference. The boundary test allows exactly those files.
- **The track, caption and subtitle rules are shared**, not copied: `internal/playback/mpvprops.go` (`TrackProps`, `StyleProps`, `TracksFrom`, subtitle download) holds them with no cgo. The desktop `internal/player` is unchanged and can adopt them later.
- **Hardware decoding is chosen per file.** A session starts with `hwdec=videotoolbox`. mpv's iOS GLES interop refuses 10-bit frames (`p010`), so when `video-params/hw-pixelformat` says `p010`, or mpv logs `Format unsupported`, the engine sets `videotoolbox-copy` (mpv re-initialises the decoder and seeks back). A file that fails in hardware before its first frame is loaded again once with `hwdec=no`. Device settings can turn hardware decoding off.
- **The video view covers the whole screen; the webview stays inside the safe area** (Wails lays it out that way), transparent while the host is attached and given back its backing on detach, so the controls respect the notch and the home indicator and the picture does not.
- **The player route is the desktop's, adapted for a finger** (`isTouch()`, and `feature("desktopControls" | "streamSwitcher" | "playerPanels")` for what is left out): a tap hides or shows the controls, a double tap on the left or right third skips 10 s, the dock is two rows, and the picture, sound, quality, framing, stats, loops, screenshots, mini player, party, fullscreen, shortcuts and stream switcher are not offered.
- **Ranking prefs on iOS:** Auto no longer looks for HDR (libmpv tone-maps it) and caps at 1080p; a choice in Settings still wins. Torrent-only streams are hidden (Phase 2) and the boundary test keeps torrent code out.
- **Packaging.** `ios:libmpv` builds `build/libmpv/.work/libmpv.xcframework` unless it is there; the build links the slice for the platform, and `embed:libmpv` copies the framework into `Peli.app/Frameworks` and signs it before the app. The notices say where the framework is and how to replace it (LGPL relinking, which is why it is dynamic).

## Consequences

- OpenGL ES is deprecated by Apple but is mpv 0.41's only iOS render path; the exit (a Metal backend) is not upstream.
- The simulator renders GLES in software, so speed numbers are the simulator's; `PELI_VIDEO_SCALE=1` draws a 1x drawable there. A device run is still owed.
- HDR and Dolby Vision play tone-mapped (see the coverage notes); showing HDR is out of scope.
- Background playback, lock-screen controls (`SetNowPlaying` is accepted and ignored), Picture in Picture and the last report on backgrounding are Phase 6.
