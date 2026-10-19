# Spike: libmpv via cgo in a Wails v3 window

Throwaway code for [#3](https://github.com/k22i/Sinag/issues/3). The findings are
in [`docs/spikes/libmpv-cgo.md`](../../docs/spikes/libmpv-cgo.md). Don't build on this code.

The #2 harness ([`spikes/mpv-wid-ipc`](../mpv-wid-ipc/)) with the mpv child process swapped for libmpv, linked in-process through cgo. It's its own Go module, so the app's `go.mod` is untouched. It:

1. binds the libmpv client API in [`mpv.go`](mpv.go): `mpv_create`, `mpv_set_option` (`wid` as `MPV_FORMAT_INT64`), `mpv_initialize`, `mpv_command`, `mpv_observe_property`, `mpv_get_property`, `mpv_wait_event`, `mpv_terminate_destroy`,
2. embeds mpv's video window in the Wails window through `wid` (Windows HWND / X11 XID),
3. runs one event-loop goroutine on `mpv_wait_event` and turns mpv events into Wails events: `player:time`, `player:tracks`, `player:buffering`, `player:ended` (plus `player:state` for everything else), each stamped with the Go time it was received,
4. draws a React overlay that renders those events, measures their delivery latency, and reports which pointer and keyboard input reaches the webview.

Windows and Linux only. On macOS `wid` isn't supported, which is #4's problem.

## Modes

| `SPIKE_MODE` | What |
|---|---|
| `single` | One window. Video embedded in it, React UI drawn by the same webview on a transparent background. |
| `overlay` | Video embedded in the main window, React UI in a second frameless, transparent window that tracks the main one (needed on X11). |
| `composition` | Windows only. Like `single`, but WebView2 uses DirectComposition visual hosting. |

On Windows, `SPIKE_WIN_HOST` picks what `wid` points at: `window` (the Wails top-level HWND, as in #2) or `container` (a disabled child HWND the spike creates at the bottom of the z-order).

## Build

Needs libmpv headers and library, and a C compiler for cgo.

- **Linux**: `libmpv-dev` (Debian/Ubuntu). `pkg-config mpv` is used.
- **Windows**: mingw-w64 gcc plus a libmpv dev package, e.g. [shinchiro's `mpv-dev-x86_64-*.7z`](https://github.com/shinchiro/mpv-winbuild-cmake/releases), extracted to `lib/win64`. Cross-compiling from Linux:
  ```sh
  CGO_ENABLED=1 GOOS=windows GOARCH=amd64 CC=x86_64-w64-mingw32-gcc \
  CGO_CFLAGS="-I$PWD/lib/win64/include" CGO_LDFLAGS="-L$PWD/lib/win64" \
  go build -o bin/spike.exe . && cp lib/win64/libmpv-2.dll bin/
  ```

```sh
./scripts/make-media.sh                       # media/test.mp4 (needs ffmpeg)
(cd frontend && npm install && npm run build)
go build -o bin/spike .
SPIKE_MODE=single ./bin/spike
```

## Self-test

Set `SPIKE_SELFTEST=results/<name>.json` to run the scripted checks: play local, observe, pause/seek/resume, audio track switch, play to the end (`ended`), loopback HTTP, a throttled HTTP stream (`buffering`), then hold for input probes. The runner scripts set it for you:

- **Linux X11** (Xvfb + openbox + picom), in Docker:
  ```sh
  docker build -t sinag-spike-libmpv scripts/linux
  docker run --rm -v "$PWD":/spike sinag-spike-libmpv scripts/linux/run.sh single    # or overlay
  ```
- **Windows**: `.github/workflows/spike-libmpv-cgo.yml` cross-compiles on Linux, runs `scripts/windows/run.ps1` on hosted runners, and uploads `results/` as artifacts.

Other knobs: `SPIKE_MPV_ARGS` (extra mpv options, command-line spelling), `SPIKE_WIN_ZORDER=bottom|none` and `SPIKE_WIN_DISABLE=1|0` (what to do to mpv's HWND when `SPIKE_WIN_HOST=window`), `SPIKE_KEEP_LOCALE=1` (skip the `LC_NUMERIC` fix, Linux), `SPIKE_SLOW_KBPS` (throttled stream rate), `SPIKE_REMOTE_URL`, `SPIKE_WINDOW_{X,Y,W,H}`.
