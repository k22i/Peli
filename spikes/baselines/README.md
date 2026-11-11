# Spike: baseline measurements (installer size, cold start, idle memory)

Throwaway code for [#7](https://github.com/k22i/Peli/issues/7). The findings are
in [`docs/spikes/baselines.md`](../../docs/spikes/baselines.md). Don't build on this code.

An empty Wails v3 shell (React sidebar, header and empty page; Wails beta.28, the app's version), built with and without libmpv, packaged the way #77–#79 would ship it, and measured. It's its own Go module, so the app's `go.mod` is untouched.

- [`main.go`](main.go): the app. A transparent window (as the player needs, #3/#4) whose page paints an opaque background. It records Go-side marks (`goInit` = package init, after the loader has mapped every linked library; `appStarted`; `windowShow`; `runtimeReady`) and writes them, with the page's marks, to `BASELINE_REPORT` once the page has painted. It quits when `BASELINE_QUIT_FILE` appears.
- [`mpv_on.go`](mpv_on.go) (build tag `mpv`): links libmpv and, at `ApplicationStarted`, does what the player service would at startup (`mpv_create`, options, `mpv_initialize`, an event-loop goroutine) on a background goroutine. No file is loaded. [`mpv_off.go`](mpv_off.go) is the shell without libmpv.
- [`frontend/`](frontend/): React 18 + Vite. The page marks script start, React's first commit (`mounted`) and the frame after it (`painted` = a task after the first `requestAnimationFrame`), plus the engine's own first-contentful-paint where it has Paint Timing. `BASELINE_PAGE=home` adds a synthetic Home: a 1920×1080 hero and 8 rows × 25 distinct 342×513 JPEG posters drawn on a canvas, to see what decoded images cost.
- [`bench/`](bench/): the launcher. It spawns the app N times and records, per run, every mark relative to the spawn, then samples the memory of the **whole process tree** at fixed times after first paint: the app plus WebView2's processes (Windows), WebKitGTK's (Linux), or WebKit's XPC services, found through their responsible pid as Activity Monitor does (macOS). Metrics: macOS `phys_footprint` (Activity Monitor's "Memory"), Windows private working set (Task Manager's "Memory") plus private bytes and working set, Linux PSS plus RSS.
- [`scripts/macos/control/main.m`](scripts/macos/control/main.m): a native control, a plain Cocoa app with one `WKWebView` and the same page as static HTML (no Wails, Go or React). It reports the same marks, so the launcher measures the platform's floor.
- [`scripts/summary.py`](scripts/summary.py): prints the tables in the findings doc from `results/*.json`.
- [`scripts/`](scripts/): packaging and runs per OS, below.

## Run

Build the frontend first: `(cd frontend && npm install && npm run build)`.

- **macOS** (Homebrew `mpv` for headers and the `brew` variant; `gh` for downloads):
  ```sh
  scripts/macos/package.sh    # .app + DMG (UDZO/ULFO/ULMO) per libmpv variant -> results/sizes-macos.json
  scripts/macos/bench.sh      # launches through LaunchServices (`open`) -> results/macos-*.json
  ```
  `scripts/macos/bundle-brew.py` copies Homebrew's libmpv and every Homebrew dylib it needs into `Contents/Frameworks` with `@rpath` install names.
- **Windows**: the [`spike-baselines`](../../.github/workflows/spike-baselines.yml) workflow cross-builds on Ubuntu with mingw-w64, packs NSIS installers with `makensis` ([`scripts/windows/package.sh`](scripts/windows/package.sh), [`installer.nsi`](scripts/windows/installer.nsi)), then installs each silently on a `windows-2025` runner and runs the launcher.
- **Linux**: the same workflow on `ubuntu-24.04` ([`scripts/linux/package.sh`](scripts/linux/package.sh): `.deb` via nfpm, AppImage via `wails3 generate appimage`; [`scripts/linux/bench.sh`](scripts/linux/bench.sh) under Xvfb). Locally: `docker build -t peli-spike-baselines scripts/linux`, then from the repo root `docker run --rm --privileged -v "$PWD":/repo -w /repo/spikes/baselines peli-spike-baselines scripts/linux/package.sh` (the same image runs `scripts/windows/package.sh`).

libmpv builds compared:

| Variant | Where from | mpv | Licence |
|---|---|---|---|
| `brew` (macOS) | Homebrew `mpv` 0.41 and its 49 dependent dylibs | 0.41.0 | GPL |
| `mediakit` (macOS, Windows) | [media-kit/libmpv-darwin-build](https://github.com/media-kit/libmpv-darwin-build) v0.7.3 `video-default` / `video-full`, [media-kit/libmpv-win32-video-build](https://github.com/media-kit/libmpv-win32-video-build) 2023-09-24: trimmed FFmpeg, no Lua/JS/Vulkan | 0.36.0 | LGPL |
| `shinchiro` (Windows) | [shinchiro/mpv-winbuild-cmake](https://github.com/shinchiro/mpv-winbuild-cmake) 20261012 (the build #3 used) | 0.41.0-git | GPL |
| `zhongfly-lgpl` (Windows) | [zhongfly/mpv-winbuild](https://github.com/zhongfly/mpv-winbuild) 2026-10-11 `mpv-dev-lgpl` | 0.41.0-git | LGPL |
| distro (Linux) | Ubuntu 24.04 `libmpv2` | 0.37.0 | GPL |

Each run writes `results/<label>.json`: the host, every run's marks (`msFromSpawn`), per-process memory samples, and a summary (run 1 on its own, then min/p50/max of the rest).
