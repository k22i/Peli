# Spike: libmpv on iOS under a Wails v3.1.0 iOS webview

Throwaway code. Question: can Peli's libmpv (our LGPL build, ADR-0003) draw video in a native view **under a transparent Wails WKWebView on iOS**, the way `internal/player/host_darwin.m` does on macOS, and at what cost? Run on the iOS 27.2 simulator (iPhone 18 Pro, iPad Pro 11-inch M5); no device was available.

## Verdict: go, with caveats

libmpv builds for iOS from our pins, as a dynamic LGPL `.xcframework`, with no source patches. It plays every fixture we threw at it (MKV HEVC 10-bit, E-AC-3/AC-3/DTS/Opus/AAC, ASS/SRT/PGS, AV1, MP4) behind a transparent webview, on iPhone and iPad, in both orientations, over HTTP with Range and over HTTPS. The HTML controls drive it through Wails bindings and Wails events. What is **not** proven is speed: the simulator renders OpenGL ES in software, so frame rates here say nothing about a device. The caveats, most serious first:

1. **Wails 3.1.0 does not launch against the iOS 27 SDK.** iOS 27 kills any app linked against its SDK that does not use the UIScene lifecycle (`UIScene life cycle is required for apps built with this SDK`), and Wails' app delegate builds its own `UIWindow`. The spike works around it by stamping the binary as linked against SDK 18.0 (`-Wl,-platform_version,ios-simulator,16.0,18.0`, `SDK_STAMP=18.0` in `build.sh`). That cannot ship: the App Store requires current-SDK builds. Wails (upstream or a patch of `application_ios_delegate.m`) has to adopt scenes before any iOS release. This blocks the whole iOS port, not just the player.
2. **10-bit video needs `videotoolbox-copy`.** With `hwdec=videotoolbox`, mpv's iOS GLES interop (`hwdec_ios_gl.m`) rejects `p010` (`videotoolbox: Format unsupported`) and the screen stays a solid colour. `videotoolbox-copy` works (copies frames back to memory and uploads them: more CPU and bandwidth). Most HEVC streams are 10-bit, so the player must choose the hwdec mode per stream (probe `video-params/hw-pixelformat`, or retry with `-copy` on that error). HDR → SDR tone mapping then runs in the GLES shaders. All of this is **unverified on a device**.
3. **OpenGL ES is deprecated.** It still works on iOS 27, but it is the only render path mpv 0.41 has on iOS. See the render path section.
4. PiP is not possible with this path without extra work (below).

## Layout of the spike

| Path | |
|---|---|
| `../../build/libmpv/build-ios.sh` | iOS cross build of libmpv from `sources.txt`: two slices and the xcframework |
| `main.go`, `player_ios.go`, `scenario_ios.go`, `player_other.go` | Wails app: `Player` service (bindings), mpv events → Wails events, a scripted scenario runner for the tests |
| `mpvview.h`, `mpvview_ios.m` | The native side: GLES video view, render loop, view insertion, mpv client API |
| `frontend/index.html` | The transparent controls page |
| `build.sh` | Builds, links, embeds `libmpv.framework`, signs, and bundles the app (device or simulator) |
| `scripts/make-media.sh`, `scripts/mkpgs.py`, `scripts/serve` | Fixtures (ffmpeg + a hand-built PGS stream) and a Range-capable HTTP server |
| `scripts/run-case.sh`, `scripts/run-matrix.sh`, `scripts/summarize.py` | Drives the simulator, takes screenshots, collects results |
| `results/` | Raw per-run JSON lines and mpv logs. `screenshots/` has the ones quoted below |

## Build and run

```sh
python3 -m venv /tmp/venv && /tmp/venv/bin/pip install meson ninja && export PATH=/tmp/venv/bin:$PATH

build/libmpv/build-ios.sh                    # ios-arm64 + ios-sim-arm64 -> build/libmpv/.work/libmpv.xcframework
GOBIN=/tmp/gobin go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0
cd spikes/ios-libmpv
scripts/make-media.sh                        # media/ (git-ignored)
go run ./scripts/serve -dir media &          # 127.0.0.1:8765, Range support
SDK_STAMP=18.0 WAILS3=/tmp/gobin/wails3 ./build.sh sim      # or: device (needs real signing to run)
xcrun simctl install booted bin/ioslibmpv.app && xcrun simctl launch booted app.peli.libmpvspike
scripts/run-matrix.sh <device-udid> iphone   # scripted run of every fixture, screenshots into results/
```

`xcodebuild -downloadPlatform iOS` installed the simulator runtime (iOS 27.2, 8.3 GB). The simulator reaches the Mac's `127.0.0.1` directly.

## libmpv for iOS

`build/libmpv/build-ios.sh` is a sibling of `build.sh` (it copies the source-fetch helpers; a production version should share them in a `common.sh`). Same pins, same FFmpeg trim, LGPL (`-Dgpl=false`; FFmpeg checked for "LGPL version 2.1 or later"; no GPL strings in `BUILD-INFO.txt`).

| | Result |
|---|---|
| Slices | `ios-arm64` (device, `arm64-apple-ios16.0`) and `ios-arm64-simulator` |
| Packaging | One flat `libmpv.framework` per slice, **dynamic**, all dependencies linked in statically (FFmpeg + VideoToolbox, libplacebo, libass + CoreText, FreeType, HarfBuzz, FriBidi, dav1d); `xcodebuild -create-xcframework` combines them. `install_name` is `@rpath/libmpv.framework/libmpv`; it links only system libraries (checked by the script) |
| Binary size | device **20.2 MB** (9.6 MB zipped), simulator 20.7 MB (9.8 MB zipped); xcframework on disk 39 MB. The app executable itself (Go + Wails) is 12 MB |
| Build time (M1 Pro class, warm sources) | device slice **2 min 35 s** from nothing but the download cache; first simulator slice about 7 min including downloads and one failed mpv compile; a relink of mpv alone is 12–19 s |
| Patches | **None** to any source. Only flags (below) |
| Flags that differ from macOS | `-Dcocoa=disabled -Dswift-build=disabled -Dgl-cocoa=disabled -Dplain-gl=enabled -Dios-gl=enabled -Dvideotoolbox-gl=disabled -Daudiounit=enabled -Dcoreaudio=disabled`; FFmpeg `--target-os=darwin --cc="clang -target arm64-apple-ios16.0[-simulator]"`. A `--native-file` is needed so fribidi's build-time generator compiles for macOS |
| Gotchas | `-Dvideotoolbox-gl` is the **macOS** interop (needs IOSurface) and must stay off; `ios-gl` supplies VideoToolbox. mpv's meson does not link `OpenGLES`/`AVFoundation` itself, so they are added to the link args (otherwise the dylib builds and fails at load). Do not export `IPHONEOS_DEPLOYMENT_TARGET` (it retargets the build-machine compiler) |

mpv features in the result: `audiounit gl ios-gl libass libplacebo ffmpeg iconv zlib` (see `BUILD-INFO.txt`).

## Render path

**libmpv render API with OpenGL ES 3** (`vo=libmpv`, `MPV_RENDER_API_TYPE_OPENGL`, `ios-gl` interop). mpv draws into an FBO whose colour attachment is the renderbuffer of a `CAEAGLLayer`, on its own serial queue with its own `EAGLContext`, then `presentRenderbuffer`. `flip_y=1`. VideoToolbox frames are mapped through a `CVOpenGLESTextureCache` (mpv's `hwdec_ios_gl.m`, unmodified).

Why this one: mpv 0.41 has no Metal VO. The Metal route is `vo=gpu-next` on libplacebo's **Vulkan** backend through MoltenVK, which means building MoltenVK and shaderc (a large C++ dependency we deliberately leave out on macOS), a Metal layer host, and a much bigger and riskier binary; and VideoToolbox's Vulkan interop (`videotoolbox-pl`) is itself unproven. GLES reuses the code path macOS already uses (render API, same threading), builds with nothing new, and works today. Cost: Apple deprecated OpenGL ES in iOS 12 (still shipping in iOS 27.2). The exit is a Metal render backend in mpv (none upstream), so a future migration means MoltenVK/`gpu-next`.

Simulator vs device:
- Simulator: mpv logs `Suspected software renderer or indirect context`. GLES runs in software: 40–600 ms per frame here, so most frames drop and timing numbers are meaningless. Decoding in software is fine.
- Simulator VideoToolbox: **H.264 hardware init fails** (`hwaccel initialisation returned error`) and mpv falls back to software. HEVC Main10 initialises (`hwdec-current=videotoolbox`) but see caveat 2. AV1 has no hardware path (software dav1d in our build; real A17 Pro+ devices have hardware AV1, which mpv's `videotoolbox` could use: unverified).
- On a device the GPU, VideoToolbox H.264 and HEVC and drawable timing differ. Expect real-time 1080p; the simulator cannot show it.

## Coverage

Fixtures: 30 s, 24 fps test pattern, served by `scripts/serve` from the Mac (`http://127.0.0.1:8765`, with Range) so every read goes through FFmpeg's HTTP client. hwdec: `videotoolbox` unless noted. "iPhone" is iPhone 18 Pro (402×874 pt, 3×); "iPad" is iPad Pro 11-inch (M5) native layout (drawable 1612×2420). Each run: play, +10 s via the HTML button, cycle audio, cycle subs, pause, resume, all driven by clicking the real buttons through `ExecJS`. Raw data in `results/`.

| Fixture | Plays | Video shown | Audio | Subs rendered | Seek | hwdec used (simulator) | CPU feel (simulator, software GL) |
|---|---|---|---|---|---|---|---|
| `hevc10-eac3-ass.mkv` HEVC Main10 1080p, E-AC-3 + AC-3, two ASS | yes | **solid colour with `videotoolbox`**; correct with `videotoolbox-copy` | AudioUnit; both tracks switch (`aid 1→2`, E-AC-3 → AC-3) | **yes**: libass styling (gold italic outline, fade, bold/italic runs, `\pos`/`\frz`, karaoke timing); second track switches | ok (±10 s exact; slider) | `videotoolbox` initialises, frames not mappable (p010); `videotoolbox-copy` works | 30–120 % of a core on iPhone (the lowest after the first seconds); unrepresentative |
| `h264-dts-srt.mkv` H.264 1080p, DTS, two SRT | yes | yes | DTS decodes (`audiounit`) | **yes** (white, outline, italic) both tracks. mpv anchors SRT at the bottom of the window, which is under the control bar unless `sub-pos`/margins are set | ok | no: software fallback (VT H.264 unavailable in the simulator) | 40–70 % of a core, ~150–450 ms per rendered frame |
| `h264-pgs.mkv` H.264 720p, AAC, PGS | yes | yes | AAC | **yes** bitmap subs at the right place and size (hand-built PGS stream, so the stream is ours, not a real disc rip) | ok | no: software fallback | 25–50 % |
| `av1.mkv` AV1 10-bit 720p, Opus | yes | yes | Opus | n/a | ok | no (software dav1d) | 30–80 %, the lightest after PGS at this size |
| `h264-aac.mp4` H.264 1080p, AAC | yes | yes | AAC | n/a | ok | no: software fallback | 40–60 % |

Additional checks (iPhone): HTTPS works (`https://test-videos.co.uk/.../Big_Buck_Bunny_360_10s_1MB.mp4`, FFmpeg Secure Transport; a 404 from `download.blender.org` also proved the TLS handshake). The audio decoders and track switching work; each "cycle" button goes through *all* tracks then **off** (mpv's `cycle audio`), which is why the table's later snapshots show `aid=no`. The transient frame drop counts are the simulator's software renderer.

Not run: a real debrid link (no TorBox key was used, nothing was added to a TorBox account). The debrid case is the same HTTPS-with-Range path, with `Content-Disposition`/redirects handled by FFmpeg's `http` protocol; the larger streams (4K HEVC HDR) are untested.

### Rotation and resizing

Rotating the iPhone to landscape (`application.IOS.SetOrientation("landscape")`, i.e. Wails' own API) resizes both layers: the video view (autoresizing mask) and the webview (Wails' `viewDidLayoutSubviews` insets it to the safe area). The renderbuffer is reallocated at the new size on the render queue and the picture stays correct. The webview stays transparent over the video: the panels' CSS `backdrop-filter: blur()` shows the video through them (`screenshots/rot-iphone-landscape.png`). iPad native layout (after adding `UIDeviceFamily` 1,2 to the Info.plist; Wails' template has none, which makes iPads run it as a scaled iPhone app) is the same.

Screenshots (`screenshots/`): `iphone-*` and `ipad-*` per fixture (`iphone-hevc10-eac3-ass-c` is ASS with the second track, `iphone-h264-dts-srt-a` SRT, `iphone-h264-pgs-a` PGS), `rot-iphone-landscape/portrait`.

## How the video view sits under Wails' webview

Wails' `window.NativeWindow()` returns, on iOS, the **`WailsViewController*`** (`nativeHandle`). Go passes it to cgo; on the main queue the Objective-C code does:

```objc
UIViewController *vc = (__bridge UIViewController *)handle;
UIView *web = [vc valueForKey:@"webView"];        // WKWebView, a Wails property
PeliVideoView *v = [[PeliVideoView alloc] initWithFrame:vc.view.bounds];   // CAEAGLLayer, autoresizing W+H
vc.view.backgroundColor = UIColor.blackColor;
[vc.view insertSubview:v belowSubview:web];
web.opaque = NO; web.backgroundColor = UIColor.clearColor;
web.scrollView.opaque = NO; web.scrollView.backgroundColor = UIColor.clearColor;
```

The page itself has a transparent `html/body`. Touches reach the webview because the video view has `userInteractionEnabled = NO`. This is the macOS layering exactly: native view below, transparent webview above.

What it relies on (fragility):
- `NativeWindow()` being the view controller (an undocumented detail of `webview_window_ios.go`: it is `w.nativeHandle`), and that it has a **`view`** and a KVC-readable **`webView`** property (`webview_window_ios.h`). A rename breaks `peli_attach` at runtime (it returns a step code, not a crash). Wails could expose the pieces officially; an upstream issue for "expose the `WKWebView` and root view" would remove the KVC.
- Wails' `viewDidLayoutSubviews` sets only the **webview's** frame (safe-area inset); the video view keeps the full window (also under the notch, as wanted). If Wails starts adding a `UITabBar` (native tabs), the web view shrinks and the video stays full screen: fine.
- `ios_window_set_background_color` / `Options.IOS.BackgroundColour` paint the root view and the webview; the spike sets alpha 0 and re-applies transparency after attach. A later call from Wails could make it opaque again (not seen; not tested for every call).
- `WindowRuntimeReady` appeared to fire more than once per launch in the simulator (the first runs loaded the file twice, before a guard was added), so attach and autostart must be idempotent. The cause was not investigated.
- The whole thing needs the window to exist: attach after `events.Common.WindowRuntimeReady`.
- The scene lifecycle issue (caveat 1) is in the same code: whoever fixes the delegate must keep `rootViewController`, `view`, and `webView` as they are.

## PiP, AirPlay, background audio, Now Playing

- **Background audio:** libmpv's `ao_audiounit` sets the `playback`/`moviePlayback` AVAudioSession category (the `AVAudioSessionCategoryPlayback` symbols are in the dylib), so adding `UIBackgroundModes: audio` should keep audio running. The GLES renderer must stop when the app is backgrounded (GL work in the background is killed by iOS); the spike parks the render queue on `UIApplicationDidEnterBackground` (implemented, not exercised). For music-style background play the player should set `vid=no` meanwhile. Unverified.
- **Now Playing / remote commands:** same as desktop `media.go`, fed from Go state: `MPNowPlayingInfoCenter` + `MPRemoteCommandCenter` from the Objective-C side. Not built here.
- **AirPlay:** audio goes to AirPlay routes through the audio session (system route picker, `AVRoutePickerView`). Screen mirroring shows the whole app. **True AirPlay video (sending the stream URL) is not possible** with mpv: only AVPlayer can hand a URL to the receiver.
- **PiP:** needs `AVPictureInPictureController` with an `AVSampleBufferDisplayLayer`; mpv's GLES render path cannot feed it. The workable design is the software render API (`MPV_RENDER_API_TYPE_SW`) or a GL readback into `CVPixelBuffer`s enqueued onto a sample-buffer layer while in PiP (extra copies, higher CPU, HDR/subtitles composited by mpv). That's several days of work on its own; plan PiP for after the player works, and decide then whether it is worth it. Treat it as unavailable in Phase 5.

## App Store and LGPL

Not legal advice. Our whole libmpv (with FFmpeg and the rest) is LGPL 2.1+ and ships as **one dynamic framework** inside the app, which users can replace: it is a separate, embedded `libmpv.framework` with its own signature, and `build-ios.sh` plus `sources.txt` rebuild it from our pinned sources (publish them with the release, as `libmpv.yml` does for macOS). The App Store re-signs the app, so "replace the library" means building a modified app from our published sources and sideloading or signing with one's own certificate. Whether that satisfies the LGPL's relink requirement for App Store distribution is a legal question for #18's audit: other LGPL-based iOS players face the same question. The bundle must carry the LGPL texts and the source offer, as on macOS. Notes: FFmpeg opens sockets itself, so plain-HTTP stream URLs are **not** subject to App Transport Security (the spike plays `http://127.0.0.1`); only an app review question. `OpenGLES` is a public, deprecated framework and still accepted for review at the time of writing (unverified for iOS 27). The simulator slice must never go in the distributed archive (the xcframework keeps them separate).

## Productionising into `internal/player` (Phase 5)

The spike's seams map straight onto an `Engine` interface behind `internal/player`'s portable `State`/`LoadOptions`/track and caption rules: `Attach(window)`, `Load(url, LoadOptions)`, `Command`/`SetProperty` (mpv property strings, the same ones the macOS host drives), `ObserveProperty` → events (`time-pos`, `pause`, `track-list`, `duration`, hwdec, `video-params`), `Close`. The Go side of the spike (`player_ios.go`) is already that shape.

| Work | Estimate |
|---|---|
| Extract the Engine interface; move `Report`/`Watching` out of `player` (audit §4); macOS engine unchanged | 3–4 d (needed with or without this spike) |
| iOS engine: productionise `mpvview_ios.m` (lifecycle, memory warnings, background/foreground, error returns, no KVC if Wails exposes the view), cgo/pkg-config wiring, cgo for `-tags ios` | 4–5 d |
| libmpv iOS in CI (`libmpv.yml` lane for `ios-arm64` + simulator, xcframework artifact, cache, notices/audit of the framework) | 2–3 d |
| hwdec policy: per-stream `videotoolbox`/`-copy`/software, 10-bit/HDR/tone-mapping, AV1, memory limits; real-device performance work | 4–6 d |
| Subtitle and layout: margins above touch controls, safe areas, bitmap subs, font choice | 2–3 d |
| Touch controls, gestures, orientation, Now Playing/remote commands, audio session and interruptions (calls, route changes), background audio | 4–5 d |
| **Wails scene lifecycle** (caveat 1) | 2–5 d, or upstream-dependent: biggest unknown |
| Device testing and tuning (none done here) | 3–5 d |

About **4–5 weeks** of one engineer, which is the audit's 3–5 week estimate with the scene problem and 10-bit handling now named. PiP not included.

The fallback, VLCKit, is not needed: libmpv builds, links, and plays. It would only come back if a device shows GLES too slow for 4K HEVC or if Wails cannot be made to run against the current SDK in time. VLCKit also has to solve the scene issue (it doesn't live in Wails' view hierarchy).

## Unverified

- Everything on a real device: GPU speed, VideoToolbox H.264/HEVC/AV1 hardware paths, thermal behaviour, the `p010` limitation (same mpv code path, so likely identical), HDR, background audio, interruptions.
- Anything with App Store review, LGPL acceptance, real debrid links, 4K, long playback, memory.
- The `SDK_STAMP` workaround proves the player works once Wails can launch; it is not a solution.
- `build.sh device` compiled and linked the arm64 app (Mach-O platform iOS) but could not run or be signed with a real identity.

## Memory notes

Suggested content for `.agents/memory/` (coordinator to file):

- `ios-libmpv-spike`: spike result (go with caveats): `build/libmpv/build-ios.sh` makes a dynamic `libmpv.xcframework` (device 20.2 MB, 9.6 MB zipped) from the macOS pins with no patches, render API on OpenGL ES (`ios-gl`), `-Dvideotoolbox-gl` must stay off on iOS; `spikes/ios-libmpv` layers a `CAEAGLLayer` view under the Wails `WKWebView` through `NativeWindow()` (a `WailsViewController`, KVC `webView`). **Why:** Phase 5 builds on it. **How to apply:** 10-bit HEVC needs `videotoolbox-copy`; libass/PGS/rotation work; simulator GL is software so judge speed on a device.
- `wails-ios-scene-lifecycle`: Wails 3.1.0's iOS app delegate has no UIScene support, so an app linked against the iOS 27 SDK refuses to launch ("UIScene life cycle is required"); the spike stamps the binary with SDK 18.0 as a workaround. **How to apply:** fix before any iOS release; `UIDeviceFamily` is also missing from the template Info.plist (iPad runs as a scaled iPhone app).
- `ios-simulator-recipe`: `xcodebuild -downloadPlatform iOS` (8.3 GB), devices exist already; `simctl launch` passes env with a `SIMCTL_CHILD_` prefix; app container `Documents/` is where a test can leave markers; `simctl io screenshot`; no `Simulator.app` is needed.
