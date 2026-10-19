# Spike: mpv `--wid` + JSON IPC in a Wails v3 window

Throwaway code for [#2](https://github.com/k22i/Sinag/issues/2). The findings are
in [`docs/spikes/mpv-wid-ipc.md`](../../docs/spikes/mpv-wid-ipc.md). Don't build on this code.

A standalone Wails v3 app (its own Go module, so the main app's `go.mod` is untouched) that:

1. gets the native handle of its main window (HWND / X11 XID / NSView*),
2. launches `mpv --wid=<handle> --input-ipc-server=<socket|pipe>` with no OSC/OSD and no mpv input handling,
3. drives mpv over JSON IPC (`loadfile`, `pause`, `seek`, `aid`) and observes `time-pos`, `duration`, `pause`, `track-list`, `vo-configured`,
4. draws a React overlay (controls, a pointer probe, diagnostics) above the video, and reports which pointer and keyboard events reach the webview.

## Modes (`SPIKE_MODE`)

| Mode | What |
|---|---|
| `single` | One window. mpv is embedded in it and the React UI is drawn by the same webview on a transparent background. |
| `overlay` | mpv is embedded in the main window. The React UI lives in a second frameless, transparent window owned by (Windows) or transient for (X11) the main one. |
| `composition` | Windows only. Like `single`, but WebView2 uses DirectComposition visual hosting (`WebView2CompositionHosting`). |

## Run

```sh
./scripts/make-media.sh                       # media/test.mp4 (needs ffmpeg)
(cd frontend && npm install && npm run build)
go build -o bin/spike .
SPIKE_MODE=single ./bin/spike                 # interactive; MPV_BIN=/path/to/mpv if not on PATH
```

Self-test: set `SPIKE_SELFTEST=results/<name>.json` to run the scripted IPC checks and write the results. The runner scripts set it for you:

- **Linux** (X11 via Xvfb + openbox + picom, Wayland and XWayland via headless Weston), in Docker:
  ```sh
  docker build -t sinag-spike-linux scripts/linux
  docker run --rm -v "$PWD":/spike sinag-spike-linux scripts/linux/run.sh x11 overlay
  ```
- **Windows**: `.github/workflows/spike-mpv-wid-ipc.yml` runs `scripts/windows/run.ps1` on a hosted runner and uploads `results/` as artifacts.
- **macOS**: `SPIKE_SELFTEST=$PWD/results/macos-single.json ./bin/spike`.

Other knobs: `SPIKE_MPV_ARGS` (extra mpv flags), `SPIKE_WIN_ZORDER=bottom|none` and `SPIKE_WIN_DISABLE=1|0` (what to do to mpv's child HWND on Windows), `SPIKE_REMOTE_URL` (also play a public URL), `SPIKE_WINDOW_{X,Y,W,H}`.
