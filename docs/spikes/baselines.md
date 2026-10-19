# Spike: baselines — installer size with libmpv, cold start, idle memory

Issue: [#7](https://github.com/k22i/Sinag/issues/7) · Epic: [#1](https://github.com/k22i/Sinag/issues/1) · Previous spikes: [libmpv via cgo](libmpv-cgo.md) (#3), [mpv render API](mpv-render-api.md) (#4) · Date: 2026-10-12
Spike code: [`spikes/baselines/`](../../spikes/baselines/) (throwaway). Raw results: [`spikes/baselines/results/`](../../spikes/baselines/results/).

## Verdict

**The NFR targets are reachable on Windows and macOS, and for Linux distro packages and Flatpak. Two things are not reachable as written: an AppImage under 60 MB, and a 2 s cold start on a Windows machine's very first launch. Linux idle memory couldn't be judged without a GPU and is the open risk.**

| Target (#86, #77–#79) | Windows | macOS | Linux |
|---|---|---|---|
| **Installer ≤ 60 MB** with libmpv | ✅ 14.5–39.5 MB (solid LZMA NSIS); 18.3–52.8 MB with today's zlib `project.nsi` | ✅ per arch: 8.4–24.0 MB DMG (ULMO). ⚠️ universal with a full libmpv ≈ 48 MB ULMO, ≈ 67 MB UDZO (estimate) | ✅ `.deb` 4.0 MB (distro deps). ✅ Flatpak: Celluloid, a GTK4 + libmpv app, is a 66 MB download *including* libmpv on a shared runtime. ❌ **AppImage 80 MB before libmpv**, 150 MB with it |
| **Cold start ≤ 2 s** (Home interactive, from cache) | ✅ warm: empty shell painted in **0.86–1.0 s** (p50, 2-vCPU runner, no GPU). ❌ **first launch after install: 3.5–4.8 s**, all of it WebView2 creating its profile | ✅ **0.72–0.76 s** (p50, M1 Pro, LaunchServices launch), of which Wails adds ~40 ms over a native WKWebView app | ✅ warm: **0.50 s** shell, 0.58 s with libmpv, 1.26 s from the AppImage (2-vCPU runner, Xvfb). ⚠️ first launch 3.2 s (GTK/fontconfig caches) |
| **Idle memory ≤ 250 MB** with Home open | ✅ shell 66–73 MB, synthetic Home 91–100 MB (private working set, Task Manager's number) | ⚠️ shell 75 MB, **synthetic Home 203 MB** (230 MB counting system helpers) | ❓ **unverified**: without a GPU, shell 443 MB and Home 768 MB (PSS), mostly Mesa's software GL; 260 MB for the shell with GL rendering off. Real-desktop numbers are needed |

What this means for v1:

- **Installer size is driven by the libmpv build, not by us.** Our Go + Wails + React binary is 9–10 MB per arch. A full-featured GPL libmpv adds 64 MB (macOS, 50 dylibs) to 121 MB (Windows, one DLL) unpacked, and compresses to 20–35 MB. A trimmed LGPL build adds 20–30 MB unpacked, 6–10 MB compressed. Both fit; the trimmed build leaves room for a universal macOS DMG and for an AppImage-free Linux story. #77/#78 should pick a compressor deliberately: today's templates use zlib (NSIS) and UDZO (DMG), which cost 25–40 % over LZMA / ULMO.
- **Linking libmpv costs nothing measurable at startup.** Loading it adds 0–30 ms before our code runs, `mpv_initialize` on a background goroutine finished before the window showed in every run (3–90 ms), first paint didn't move, and idle memory grew by 2–5 MB.
- **Startup is the webview's, not ours.** On macOS a plain Cocoa + WKWebView app paints in 0.70 s and the Wails shell in 0.74 s. On Windows, 0.8 s of the 0.9 s is WebView2 starting. On Linux the shell paints in 0.5 s. That leaves **~1.0–1.5 s for Home to become interactive from cache** inside the 2 s target, which is the real budget for #12/#14/#42.
- **Memory is decoded images, plus WebKitGTK on Linux.** The empty shell idles at 66–75 MB on Windows and macOS. On macOS, 200 posters + a hero added 128 MB in WebKit's WebContent process, putting a Home without virtualisation at 203–230 MB of a 250 MB budget. #41's virtualised rows and lazy images are what keep us under it. On Linux the GPU-less runner can't tell us the real figure, and even with GL off the empty shell was ~260 MB, so Linux needs a measurement on a real desktop before we commit.

Recommended target changes for #8: keep **≤ 60 MB per installer** but exempt AppImage (or drop AppImage for Flatpak + `.deb`), state it **per architecture** on macOS, split cold start into **"first launch after install ≤ 5 s"** and **"subsequent launches: Home interactive ≤ 2 s"**, and keep 250 MB on Windows/macOS but treat Linux as unconfirmed until it's measured on real hardware. [Details at the end.](#targets-and-recommendations-for-8)

## What was measured

An **empty Wails v3 shell**: the app's stack (Wails v3 beta.28, React 18, Vite), a sidebar with the 6 nav items, a header with a search box and an empty page, in a transparent window like the player needs (#3/#4). Built with and without libmpv, packaged the way #77–#79 would ship it:

- **With libmpv**, the app links it and, at `ApplicationStarted`, does what the player service would at startup on a background goroutine: `mpv_create`, the options #3/#4 settled on (`vo=libmpv` on macOS/Linux, `vo=gpu` on Windows, `hwdec=auto-safe`), `mpv_initialize`, and an event-loop goroutine. No file is loaded.
- **Synthetic Home** (`BASELINE_PAGE=home`): a 1920×1080 hero plus 8 rows × 25 distinct 342×513 JPEG posters (TMDB's `w342`), all mounted, no virtualisation. It's a deliberately heavy stand-in for Home, to see what decoded images cost.

The launcher ([`bench/`](../../spikes/baselines/bench/)) spawns the app 10 times (3 for Home) and records:

- **Startup marks relative to the spawn:** `goInit` (Go package init: the OS loader has mapped every linked library, libmpv included), `appStarted` (Wails `ApplicationStarted`), `windowShow`, and **`painted`**: the page's first frame after React's first commit (a task after the first `requestAnimationFrame`). The engine's own first-contentful-paint landed within ±30 ms of `painted` in every engine. **"Cold start" below means spawn → `painted`.**
- **Memory of the whole process tree** 5 s and 15 s after first paint (and 30 s for Home): the app plus its webview processes. On Windows these are WebView2's `msedgewebview2.exe` children; on Linux, WebKitGTK's children; on macOS, WebKit's XPC services, found through their responsible pid as Activity Monitor does. Metrics are each OS's user-facing one: **macOS `phys_footprint`** (Activity Monitor's "Memory"), **Windows private working set** (Task Manager's "Memory"), **Linux PSS**. Secondary numbers (Windows private bytes, macOS including system helpers, RSS) are in the raw files.

Run 1 is reported separately ("first launch"); the rest are summarised as p50. Sizes are in MB = 10⁶ bytes; memory in MiB.

### Where and how (read before trusting the numbers)

- **macOS: this Mac** (M1 Pro, 8 cores, 16 GB, macOS 27.0.1, external 3840×1600 display), **in use during the runs** and with a Docker VM running. Apps were launched through LaunchServices (`open -n -F`), as a Dock or Finder launch would be. A plain exec from a terminal makes the terminal the "responsible" process, which hides WebKit's processes from the measurement. One run was discarded because its window opened behind another and WebKit never painted it, and one Home run because the display slept. These are warm-disk-cache launches: we couldn't purge the file cache without root, and a downloaded app's first-launch Gatekeeper check isn't included (nothing here is notarised).
- **Windows: GitHub-hosted `windows-2025` runners** (Server 2025 build 26100, 2 vCPU, 8 GB, **no GPU**), one fresh VM per variant. Each variant was installed with its own NSIS installer (`/S`), so **run 1 is a genuine first launch after install on a machine that had never run the app.**
- **Linux: GitHub-hosted `ubuntu-24.04`** (amd64, 2 vCPU, 8 GB, no GPU) under Xvfb with no compositor or window manager; WebKitGTK renders in software. Ubuntu 24.04's GTK 4.14, WebKitGTK 2.52 and libmpv 0.37.
- CI runners are noisy: a few Windows runs took 1.7–1.9 s for no reason we could see. p50 over 9 warm runs absorbs that; the min–max is in the raw files.

## Installer size

### libmpv builds compared

| Build | mpv | Licence | Unpacked | Notes |
|---|---|---|---|---|
| Windows: [shinchiro](https://github.com/shinchiro/mpv-winbuild-cmake) `20261012` (the build #3 used) | 0.41.0-git | GPL | 121.0 MB, one DLL | Imports `vulkan-1.dll` |
| Windows: [zhongfly](https://github.com/zhongfly/mpv-winbuild) `mpv-dev-lgpl` 2026-10-11 | 0.41.0-git | LGPL | 101.2 MB, one DLL | Also imports `vulkan-1.dll` |
| Windows: [media-kit](https://github.com/media-kit/libmpv-win32-video-build) 2023-09-24 | 0.36.0 | LGPL | 29.8 MB, one DLL | Trimmed FFmpeg; no Vulkan import. Three years old |
| macOS: Homebrew `mpv` 0.41 + every Homebrew dylib it pulls in | 0.41.0 | GPL | 63.9 MB, 50 dylibs | Built for macOS 27 only (`minos 27.0`), so not shippable as is |
| macOS: [media-kit](https://github.com/media-kit/libmpv-darwin-build) v0.7.3 `video-default` | 0.36.0 | LGPL | 21.1 MB arm64, 42.4 MB universal, 18 dylibs | Trimmed FFmpeg 6.0 (H.264/HEVC/AV1/VP9, VideoToolbox, common audio), no Lua/JS/libplacebo. `video-full`: 24.9 MB |
| Linux: Ubuntu 24.04 `libmpv2` | 0.37.0 | GPL | ~170 MB with its deps (AppImage only) | `.deb` depends on it instead |

The media-kit builds are a stand-in for "a trimmed LGPL libmpv we build ourselves", not something to ship: they're mpv 0.36 and lack features we may want (TrueHD decoding, libplacebo's HDR tone-mapping).

### Windows (NSIS, x64)

| Variant | exe + DLL | NSIS zlib (today's `project.nsi`) | **NSIS solid LZMA** | Portable zip |
|---|---|---|---|---|
| Shell, no libmpv | 9.8 MB | 5.8 MB | **4.9 MB** | 3.9 MB |
| media-kit (LGPL, trimmed) | 9.9 + 29.8 MB | 18.3 MB | **14.5 MB** | 16.4 MB |
| zhongfly (LGPL, full) | 9.9 + 101.2 MB | 47.7 MB | **36.3 MB** | 45.7 MB |
| shinchiro (GPL, full) | 9.9 + 121.0 MB | 52.8 MB | **39.5 MB** | 50.9 MB |

Installers include the 1.8 MB WebView2 bootstrapper and are built from the app's `project.nsi` and `wails_tools.nsh`, changed only to install the DLL ([`installer.nsi`](../../spikes/baselines/scripts/windows/installer.nsi)). Each was installed silently on the runner and launched from `Program Files`. **All fit under 60 MB; with a full libmpv, today's zlib setting leaves only 7 MB of headroom, and `SetCompressor /SOLID lzma` buys 13 MB.**

### macOS (DMG)

| Variant | Arch | exe | libmpv + deps | .app | DMG UDZO (Wails default) | ULFO (lzfse) | **ULMO (lzma)** |
|---|---|---|---|---|---|---|---|
| Shell, no libmpv | arm64 | 9.0 MB | – | 9.1 MB | 4.2 MB | 3.9 MB | **3.0 MB** |
| Shell, no libmpv | universal | 18.8 MB | – | 18.8 MB | 8.6 MB | 8.0 MB | **6.2 MB** |
| media-kit `video-default` | arm64 | 9.0 MB | 21.1 MB | 30.2 MB | 12.9 MB | 11.8 MB | **8.4 MB** |
| media-kit `video-full` | arm64 | 9.0 MB | 24.9 MB | 34.0 MB | 15.2 MB | 14.0 MB | **10.7 MB** |
| media-kit `video-default` | universal | 18.8 MB | 42.4 MB | 61.3 MB | 27.3 MB | 25.0 MB | **18.6 MB** |
| Homebrew 0.41 (GPL, full) | arm64 | 9.0 MB | 63.9 MB | 73.0 MB | 33.5 MB | 31.5 MB | **24.0 MB** |

Homebrew's libmpv was made self-contained with [`bundle-brew.py`](../../spikes/baselines/scripts/macos/bundle-brew.py) (copy every Homebrew dylib it needs into `Contents/Frameworks`, rewrite install names to `@rpath`, re-sign). A universal build of a full libmpv wasn't possible from Homebrew (arm64 only). Universal roughly doubles everything else here, so a **universal full-featured DMG would be ≈ 67 MB UDZO / ≈ 48 MB ULMO**: over the target with today's DMG format, under it with ULMO (macOS 10.15+). Separate arm64 and Intel DMGs are comfortably under either way. Both libmpv variants were loaded and initialised in the bench runs (the report records mpv 0.41.0 vs 0.36.0), so the bundling works.

### Linux

| Package | Shell, no libmpv | With libmpv |
|---|---|---|
| `.deb` (nfpm, depends on `libgtk-4-1`, `libwebkitgtk-6.0-4`, `libmpv2`) | 4.0 MB | 4.0 MB |
| **AppImage** (`wails3 generate appimage`: linuxdeploy + GTK plugin, bundles everything) | **80.3 MB** (251.6 MB unpacked, 334 files) | **150.1 MB** (430.2 MB unpacked, 579 files) |
| Flatpak (not built; Flathub's numbers for comparable apps) | | Celluloid (GTK4 + libmpv): **66 MB download**, 145 MB installed, on the GNOME 51 runtime. mpv itself: 99 MB / 244 MB, on freedesktop 25.08 |

Where the AppImage's bytes go (amd64, unpacked): `libwebkitgtk-6.0.so` 94.1 MB, `libjavascriptcoregtk-6.0.so` 32.6 MB, `libicudata.so` 30.8 MB, GTK 12.0 MB, our binary 9.6 MB, two copies of librsvg 13.4 MB. With Ubuntu's libmpv, also `libcodec2` 16.9 MB, `libavcodec` 16.6 MB, `libx265` 16.5 MB (an encoder mpv doesn't need for playback), `libavfilter` 13.6 MB, `libplacebo` 8.9 MB and ~150 more libraries.

- **The AppImage can't meet 60 MB, with or without libmpv**: WebKitGTK, JavaScriptCore and ICU alone are ~158 MB unpacked, ~70 MB compressed. A trimmed libmpv (media-kit-sized, ~8 MB compressed) would bring it to roughly 90 MB, not under 60.
- **Flatpak meets it in the sense that matters.** The GNOME runtime (WebKitGTK included) is a shared download most Flatpak users already have. Our app's own part would be our 10 MB binary plus libmpv and its FFmpeg. Celluloid's 66 MB download is a close analogue with a full-featured mpv; with a trimmed one we'd be well under. (The Flathub sizes come from `flatpak remote-info` in the CI job. The size parser lost the units, so the JSON holds the numbers flatpak printed, in MB, except the GNOME runtime's installed size, which is ~1 GB. The parser is fixed for future runs.)
- **`.deb`/`.rpm` are tiny** because everything comes from the distro, at the price of whatever libmpv version the distro ships (0.37 on Ubuntu 24.04).

## Cold start

p50 of warm launches (runs 2–10) in ms after the spawn; first launch is run 1.

| | goInit | appStarted | windowShow | **painted** | mpv ready | First launch: painted |
|---|---|---|---|---|---|---|
| **macOS** native control (Cocoa + WKWebView, no Wails/Go/React) | 134 | 346 | 446 | **701** | | 749 |
| macOS shell | 138 | 548 | 617 | **742** | | 878 |
| macOS + media-kit libmpv | 136 | 524 | 613 | **718** | 527 | 805 |
| macOS + Homebrew libmpv (50 dylibs) | 166 | 524 | 750 | **761** | 543 | 942 |
| macOS + media-kit, universal binary | 138 | 528 | 648 | **722** | 538 | 1379 |
| **Windows** shell | 28 | 73 | 992 | **1004** | | **4838** |
| Windows + media-kit | 27 | 65 | 924 | **909** | 72 | **3455** |
| Windows + zhongfly LGPL | 35 | 61 | 859 | **861** | 72 | **4656** |
| Windows + shinchiro GPL | 37 | 68 | 911 | **919** | 79 | **4240** |
| **Linux** shell | 26 | 92 | 416 | **499** | | 3180 |
| Linux + Ubuntu libmpv | 73 | 157 | 493 | **581** | 171 | 586 |
| Linux + Ubuntu libmpv, AppImage | 384 | 496 | 1131 | **1260** | 530 | 1262 |

- **macOS: ~0.72–0.76 s to first paint, and nearly all of it is the platform.** The native control app paints at 0.70 s. Wails and Go reach `applicationDidFinishLaunching` ~200 ms later than the native app (Wails' Go/cgo setup, menus, event wiring), but then show the page ~160 ms faster after it, so the net Wails + React cost is **~40 ms**. LaunchServices and dyld account for the ~130 ms before any of our code runs. The first launch of each new build was 0.1–0.6 s slower (dyld's closure for a new binary, code-signature checks on 18–50 new dylibs).
- **Windows: ~0.9 s warm; 3.5–4.8 s on first launch.** Our process is up in 30 ms and Wails starts in 70 ms; the next 0.8 s is WebView2 creating its environment and controller and loading the page. On the very first launch after install, that step took **3.5–4.7 s**: WebView2 creates the app's user-data folder (profile, caches) and starts its browser process from cold. Every later launch was back to ~0.9 s. This is the WebView2 runtime's cost, not ours, and would be smaller on a desktop with a GPU and more cores, but **a 2 s "cold start" is not achievable for the first launch after install on a weak machine.**
- **libmpv doesn't move first paint.** Loading it is part of `goInit` (+0 ms for media-kit's 18 dylibs, +30 ms for Homebrew's 50, +10 ms for a 121 MB DLL on Windows). `mpv_initialize` ran on a background goroutine and finished before the window showed in every run: 3–17 ms (media-kit on macOS), 17–87 ms (Homebrew), 5–15 ms on Windows (~360 ms on the first launch after install, with the DLL not yet in the file cache). There's no reason to lazy-load libmpv for startup's sake.
- A universal binary costs nothing once cached; its first launch was the slowest (1.4 s, twice the file size to page in and verify).
- **Linux: 0.50 s warm (0.58 s with libmpv), the fastest of the three**, even in software rendering on a 2-vCPU runner. The first launch on a fresh runner took 3.2 s, 1.5 s of it before `ApplicationStarted` (GTK building its caches). **The AppImage adds ~0.7 s** to every launch: its runtime mounts the squashfs image over FUSE and every library (WebKitGTK included) is decompressed on first read (`goInit` 384 ms vs 73 ms).

## Idle memory

At +15 s after first paint, p50, MiB.

| | Shell | + libmpv (initialised) | Synthetic Home (+ libmpv) |
|---|---|---|---|
| **macOS** (`phys_footprint`, app + WebKit) | 75 (native control: 63) | 76 (media-kit), 80 (Homebrew) | **203** |
| macOS, also counting system helpers macOS attributes to any Cocoa app | 93 | 94, 99 | 230 |
| **Windows** (private working set, app + WebView2) | 66 | 67 (media-kit), 71 (shinchiro), 73 (zhongfly) | **93–100** |
| Windows private bytes | 116 | 123, 135, 134 | 153–164 |
| **Linux** (PSS, app + WebKitGTK), GPU-less runner, Mesa llvmpipe | 443 | 475 (distro), 478 (AppImage) | **768** |
| Linux, same, GL rendering off (`GSK_RENDERER=cairo`, `WEBKIT_SKIA_ENABLE_CPU_RENDERING=1`, `WEBKIT_DISABLE_COMPOSITING_MODE=1`; local Docker, arm64) | 262 (GL on in the same container: 456) | | |

- **The empty shell idles at 66–75 MB** on Windows and macOS, about 12 MB over a native WKWebView app. libmpv, initialised but idle, adds 1–5 MB of working set (Windows private bytes +7 to +19 MB for its heap, mostly not resident).
- **Posters are the budget.** On macOS the Home page's 200 posters + hero added **128 MB**, all in WebKit's WebContent process (21 → 145 MB): close to the 140 MB those images take decoded (342 × 513 × 4 bytes each). WebKit keeps them decoded while they're in the DOM, even off-screen. WebView2 grew far less (+25–30 MB working set): Chromium keeps decoded images in its GPU/raster caches and drops off-screen ones. **So macOS is the platform that decides whether we meet 250 MB.** With virtualised rows and lazy images (#41), only the posters near the viewport are decoded: ~30 visible posters ≈ 20 MB.
- macOS also attributes ~18 MB of system services to the app (text-input view service for the search box, Metal shader compiler, an audio sandbox helper). We report both; Activity Monitor shows them as separate processes.
- **Linux can't be judged from these runs.** With no GPU, WebKitGTK and GTK render through Mesa's llvmpipe, and both our process (GTK's renderer) and WebKit's web process carry its buffers: 443 MB for the empty shell, 768 MB with the synthetic Home. Turning GL rendering off halves the shell to ~260 MB (our process ~120 MB, web process ~105 MB, network process ~33 MB), which is still the highest of the three OSes. #4 already saw ~500 MB RSS under llvmpipe. **A real Linux desktop with a GPU has to be measured before we can say whether 250 MB holds there** (#87).

## Targets and recommendations for #8

| Target | Status | Recommendation |
|---|---|---|
| Installer ≤ 60 MB (Windows, #77) | ✅ 14.5–39.5 MB | Switch `project.nsi` to `SetCompressor /SOLID lzma`. Ship our own trimmed libmpv build (also drops shinchiro's hard `vulkan-1.dll` import, #3) and pin it. |
| Installer ≤ 60 MB (macOS, #78) | ✅ per arch; ⚠️ universal + full libmpv | State the target **per architecture**, or ship ULMO DMGs (`hdiutil -format ULMO`, macOS 10.15+) if we want universal. We need our own relocatable libmpv build regardless (Homebrew's targets macOS 27 only). |
| Package ≤ 60 MB where libmpv is bundled (Linux, #79) | ❌ AppImage 80 MB without libmpv, 150 MB with; ✅ `.deb` 4 MB; ✅ Flatpak (~66 MB analogue) | **Exempt AppImage** from the 60 MB target, or drop it and ship Flatpak + `.deb`/`.rpm`. If we keep it, bundle a trimmed libmpv instead of the distro's (Ubuntu's pulls in x265, codec2 and ~150 libraries). |
| Cold start: Home interactive ≤ 2 s from cache (#87) | ✅ warm: shell paints in 0.72–1.0 s, leaving ~1.0–1.2 s for Home. ❌ Windows first launch after install: 3.5–4.8 s | Split it: **first launch after install ≤ 5 s** (WebView2 profile creation dominates), **subsequent launches Home interactive ≤ 2 s**. Budget the ~1 s left for Home's data from SQLite (#14) and first render; don't block first paint on network or on libmpv. |
| Idle memory ≤ 250 MB with Home open (#87) | ✅ Windows ~100 MB. ⚠️ macOS 203 MB (230 MB all-in) with 200 posters and no virtualisation. ❓ Linux unverified (GPU-less: 260–440 MB for the empty shell) | Keep 250 MB, measured the way Activity Monitor / Task Manager / PSS show it. Make #41's virtualisation and lazy decoding a requirement (not a nice-to-have), and measure Home with real art in #87. **Measure Linux on a real GPU desktop before committing to the number there**; if WebKitGTK's baseline is near 250 MB, Linux needs its own target. |

Also for the tickets that follow:

- **#87 (release benchmarks):** reuse this launcher's approach. Launch through LaunchServices on macOS (or WebKit's processes are missed) and keep the window visible (an occluded WKWebView never paints). Sum the whole process tree. Report first launch after install separately from warm launches.
- **#88 (CI size check):** the sizes here come from scripts that already run in CI (cross-built NSIS on Ubuntu, `.deb` and AppImage on Ubuntu). DMGs need a macOS runner. Gate per format, with AppImage exempt or on its own limit.
- **#79 / #18:** on **Ubuntu 24.04, WebKitGTK aborts at startup** unless unprivileged user namespaces are allowed. AppArmor blocks them by default, so bubblewrap can't start the web process sandbox (`bwrap: Creating new namespace failed: Operation not permitted`, then `Failed to fully launch dbus-proxy` and SIGTRAP). The `.deb` needs to install an AppArmor profile granting `userns` (as Ubuntu's own WebKitGTK apps do). Flatpak and AppImage behave differently and need their own check. Disabling WebKit's sandbox is not an option.

## Open risks / not covered

- **Linux memory is the biggest unknown**: every Linux number is GPU-less (software GL), which inflates memory by ~190 MB here. No real GNOME/KDE desktop was measured.
- **No real Windows desktop and no GPU** on Windows or Linux: WebView2 and WebKitGTK rendered in software. Absolute times on a typical desktop should be shorter, and memory may shift between processes (GPU process). The first-launch WebView2 cost on a real desktop is unmeasured.
- **macOS: one machine, warm caches.** No truly cold boot, no notarised download (Gatekeeper's first-launch assessment adds time), no Intel Mac (the universal binary ran its arm64 slice).
- **Home is synthetic.** Canvas-made JPEGs, no network, no SQLite, no TanStack Query or router. It measures image cost, not Home's real startup. Time to first frame (≤ 3 s) and launch → first frame from Continue Watching (≤ 15 s) are not covered here; they need the player and real streams (#87).
- **Our own trimmed libmpv build wasn't made.** The media-kit builds stand in for it, but they're mpv 0.36 with a reduced decoder set. A modern trimmed build (mpv 0.41 + libplacebo, LGPL, no Vulkan import) will be larger than media-kit's and smaller than the full builds; we didn't measure where.
- Flatpak wasn't built; its size is inferred from Flathub's metadata for Celluloid and mpv.
- MSIX (#77's alternative to NSIS) and `.rpm` weren't measured.

## Reproduce

See [`spikes/baselines/README.md`](../../spikes/baselines/README.md). In short:

- macOS: `scripts/macos/package.sh` (sizes → `results/sizes-macos.json`), then `scripts/macos/bench.sh`. The native control: `bin/bench -app bin/macos/control/Sinag.app -launch open -label macos-control -out results/macos-control.json`.
- Windows and Linux: run the [`spike-baselines`](../../.github/workflows/spike-baselines.yml) workflow ([run 38207823235](https://github.com/k22i/Sinag/actions/runs/38207823235) for Windows and Linux sizes, [run 38210638912](https://github.com/k22i/Sinag/actions/runs/38210638912) for Linux startup and memory). The GL-off comparison ran in the local Docker image (`docker-arm64-*.json`).
- Tables: `python3 scripts/summary.py results/*.json`.
