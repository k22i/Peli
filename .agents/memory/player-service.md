---
name: player-service
description: "#60 player: internal/player Service + hosts, the three events, /player route, test and in-app run gotchas (one FFmpeg log instance, dev-play hook, Docker Linux runs, other Sinag windows); read before #61–#70, #91, #92"
metadata:
  type: project
---

#60 (ADR-0039): `internal/player` — `mpv.go` binding, `player.go` Service (Load/SetPaused/Seek/SeekBy/SetVolume/SetMuted/SetSpeed/SetFullscreen/Stop/Snapshot), `host_{darwin,linux,windows}.go` + `video_darwin.m`/`video_linux.c`. `player.UseWindow(svc, window)` in main.go. One session = one mpv handle, opened by Load, closed by Stop/leaving `/player`/shutdown. Events: `player:state` (whole State, coalesced), `player:time` (≤4 Hz), `player:ended` (eof | error + code expired/unsupported/failed). Frontend: `lib/player.ts` (usePlayerState = snapshot then events, usePlayerEnded, reloadExpired), `/player` route with `staticData.chrome: "none"`, history state `player: {title, source}`.

**Why:** the binding rules from M0 and the event contract are what #61–#70 build on.

**How to apply:**
- Tests use `nullHost` (vo/ao null) with real libmpv; fixtures in `internal/player/testdata` (3 s clip + HLS). libmpv sends FFmpeg's log (how `expired` is detected, needs log level `v`) to **one mpv instance per process**: tests reading it can't be `t.Parallel()`.
- Seeing it in the app without picking a stream: temporarily add a `SINAG_DEV_PLAY=<file>` hook in main.go's ApplicationStarted (sleep 6 s, `window.ExecJS(`location.hash = "/player"`)`, then `players.Load`), run with `SINAG_DATA_DIR` holding a copy of the real `~/Library/Application Support/Sinag/sinag.db` (a fresh store redirects to /welcome). Never commit the hook.
- The user often has their own Sinag running (`bin/sinag.dev.app`, also process name "sinag"): find **your** window by PID (CGWindowList `kCGWindowOwnerPID`), and kill your instance by PID — `pkill -f <path>` missed `./sinag`, and a second launch silently hands off to the first (single instance).
- Linux runs: `staysh-spike-render` Docker image (GTK4, WebKitGTK 6, libmpv 0.40, sway, Xvfb, picom), `SINAG_MPV_OPTIONS="gpu-sw ao=null"`; X11 needs picom or frames are wrong. 1080p60 in llvmpipe shows tile-grid artifacts; use a 720p30 clip to judge the host. Real-GPU check is #91's.
- Windows compile check: in that image, `apt-get install gcc-mingw-w64-x86-64`, `CGO_ENABLED=1 GOOS=windows CC=x86_64-w64-mingw32-gcc CGO_CFLAGS=-I…/spikes/libmpv-cgo/lib/win64/include CGO_LDFLAGS=-L…/win64`. Never run on Windows yet.
- CI links third-party libmpv until #92 (apt libmpv-dev, brew mpv, shinchiro 7z on Windows with CGO_ENABLED=1). Screen-awake on Linux/Windows isn't done (empty `playing` hooks); creating a follow-up issue was blocked, so it's only in #60's verdict.
- Related: [[stream-resolve]], [[stream-picker]], [[spike-ticket-workflow]].
