# Spike: mpv render API under a Wails v3 webview

Throwaway code for [#4](https://github.com/k22i/Peli/issues/4). The findings are
in [`docs/spikes/mpv-render-api.md`](../../docs/spikes/mpv-render-api.md). Don't build on this code.

The #3 harness ([`spikes/libmpv-cgo`](../libmpv-cgo/)), with `wid` embedding swapped for libmpv's **render API** (`vo=libmpv`). mpv draws into a native layer or widget that we put *below* Wails' webview, the webview stays transparent, and the React overlay from #2/#3 draws on top and receives the input. It's its own Go module, so the app's `go.mod` is untouched.

- [`mpv.go`](mpv.go): #3's client-API binding, unchanged apart from exposing the handle.
- [`video.h`](video.h), [`video.go`](video.go): what the per-OS render code exposes to Go, and the frame-timing stats it records.
- [`video_darwin.m`](video_darwin.m): macOS. A `CAOpenGLLayer`-backed `NSView` below the `WKWebView`.
- [`video_linux.c`](video_linux.c): Linux. A `GtkGLArea` or `GtkPicture` below the `WebKitWebView` in a `GtkOverlay`, or our own `wl_subsurface` below GTK's surface (Wayland).
- [`scripts/linux/vinput/`](scripts/linux/vinput/): a tiny Wayland client that keeps a virtual pointer and keyboard alive while it clicks. `wlrctl`/`wtype` remove their device before GTK can bind it.
- [`swrender.h`](swrender.h): the software render API on a render thread, shared by both.
- [`steps.go`](steps.go): the self-test steps added for #4: resize, fullscreen, minimise, HDR, and the bench.

## Modes

| `SPIKE_MODE` | OS | What |
|---|---|---|
| `gl` | macOS | `CAOpenGLLayer` view under the `WKWebView`; render API (OpenGL). Default on macOS. |
| `glarea` | Linux (X11, Wayland) | `GtkOverlay { GtkGLArea, WebKitWebView }`; render API (OpenGL) on the GTK thread. Default on Linux. |
| `gltex` | Linux (X11, Wayland) | `GtkOverlay { GtkPicture, WebKitWebView }`; mpv renders on our own thread into textures in a GL context shared with GTK's, handed over as `GdkGLTexture`s with a fence. |
| `subsurface` | Wayland | Our own `wl_surface` as a `wl_subsurface` placed below GTK's toplevel; EGL + render API on our own thread. |
| `sw` | macOS, Linux | Render API `sw` on a render thread; frames shown as `CALayer` contents / a `GtkPicture`. |
| `wid` | X11 | #3's baseline: mpv's own X window embedded with `wid` (covers the UI). |
| `overlay` | X11 | #3's baseline as it would ship: `wid` plus a second transparent window for the UI. |

Knobs: `SPIKE_NO_BLOCK=1` passes `MPV_RENDER_PARAM_BLOCK_FOR_TARGET_TIME=0`. `SPIKE_HIGH_PRIO=1` (Linux, `glarea`) schedules redraws at `G_PRIORITY_HIGH` instead of the idle priority Wails' main-thread dispatch uses. On macOS, `SPIKE_GL_THREAD=1` calls the layer's `display` on our own serial queue, and `SPIKE_GL_ASYNC=1` sets `CAOpenGLLayer.asynchronous`. `SPIKE_HDR=pq|linear` (macOS) selects a half-float layer in BT.2100 PQ or extended-linear Display P3. For debugging: `SPIKE_DEBUG_RENDERS=1` logs render counters every second, and `SPIKE_DEBUG_HIDE_WEBVIEW=1` (macOS) hides the webview. Also `SPIKE_MPV_ARGS`, `SPIKE_BENCH_MEDIA`, `SPIKE_BENCH_SECS`, `SPIKE_HDR_MEDIA`, `SPIKE_WINDOW_{X,Y,W,H}`.

## Build and run

```sh
./scripts/make-media.sh                      # media/: test.mp4, bench-1080p60.mp4, hdr10.mp4 (ffmpeg with x264/x265)
(cd frontend && npm install && npm run build)
```

- **macOS** (Homebrew `mpv` for libmpv, `pkg-config`): `go build -o bin/spike .`, then
  ```sh
  SPIKE_GL_THREAD=1 scripts/macos/run.sh gl gl-thread   # needs Screen Recording permission for screenshots
  SPIKE_GL_THREAD=1 SPIKE_HDR=pq scripts/macos/run.sh gl gl-hdr-pq
  scripts/macos/bench-mpv.sh gpu-next                    # standalone mpv, for comparison
  ```
  Keep the window visible while it runs: an occluded window isn't drawn, and the script warns when the bench ran hidden.
- **Linux**, headless in Docker (X11: Xvfb + openbox + picom; Wayland: sway's headless backend):
  ```sh
  docker build -t peli-spike-render scripts/linux
  docker run --rm -v "$PWD":/spike peli-spike-render bash -c 'go build -o bin/spike-linux . && scripts/linux/run.sh wayland glarea'
  # scripts/linux/run.sh {wayland|x11} {glarea|gltex|subsurface|sw|wid|overlay} [name]
  docker run --rm -v "$PWD":/spike peli-spike-render scripts/linux/run-all.sh   # the whole matrix
  ```

Each run writes `results/<os>-<name>.json` (steps, latency, `video.bench` etc.), a `.log`, the mpv log and screenshots.
