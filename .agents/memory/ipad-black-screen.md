---
name: ipad-black-screen
description: "iPad black-screen diagnosis (2026-11-27): all processes alive, no jetsam/kill, screen paints nothing over black; hwdec OFF on the iPad db; probe recipes via devicectl"
metadata:
  type: project
---

Diagnosis session 2026-11-27, user's iPad (`k22i iPad Pro`, iPad14,5, iPadOS 27.2.1), app v0.1.2 build 20261127.0108, bundle `k22i.net.peli.S8ZWN8F74T`. Symptom: screen turns black randomly while scrolling/navigating and assuredly on title open or play. iPhone fine. **Diagnosed, not fixed.**

**Facts captured while it sat black (all via `xcrun devicectl` on the plugged-in device):**
- Screenshot 99.5 % pure black; only the system status bar paints. Centre luma 0.0.
- ALL FOUR processes alive: peli, WebContent, GPU, Networking — PIDs consecutive (588–591), so WebContent was never killed in that session.
- Ring log (app container `Library/Application Support/logs/last.txt`, pull with `devicectl device copy from --domain-type appDataContainer --domain-identifier <bid> --source "Library/Application Support/logs"`): zero diagnostics events — no webview terminations, no memory warnings, no navigation failures, empty crash file. `memory:` line every 30 s normal, ~645 MiB footprint, 4.4 GB available.
- System crash logs domain (`--domain-type systemCrashLogs`): no jetsam, no WebContent/GPU crashes for these sessions. The only JetsamEvent (11-20) killed `appleaccountd`, unrelated.
- The black happened right after a 3840×2160 10-bit HEVC HDR play that was **software-decoded** (see below), ~18 s in, with a `store: profile not found: 0` binding error right at teardown.
- The db (bbolt, not sqlite — dump with a tiny Go program using go.etcd.io/bbolt) says `hardwareDecoding: false` on this iPad, so every stream is CPU-decoded; 4K HEVC = 171 % CPU, 1.8 GB footprint, 3–5.6 s to first frame. ([[hardware-decoding-hdr]] already noted the real db has hwdec OFF.)
- `store: profile not found: 0` fires on every player mount/teardown in both logs — a secondary bug: something calls Store with profile id 0 (profiles in the db are ids 1 and 2).
- After an overnight background, resume is followed by a burst of `context canceled` binding rejections (profile chunk), then the route-restore player auto-resumes playback within ~6 s of launch.

**Architecture facts that matter for the black screen:** `body` has no background by design (only the shell paints one; player route is transparent). During playback `peli_host_attach` (internal/iosplayer/host_ios.m) makes the WKWebView AND its scroll view non-opaque/clear at runtime and inserts a black CAEAGLLayer view under it; detach restores opacity. A page that stops compositing therefore shows pure black (window/GLES layer), not a frozen frame.

**FIXED on main 2026-11-27 (four commits, all checks green on the host; not yet run on a device):**
- `e2c34df` fix(ios) the black screen itself: `internal/diagnostics/watchdog.go` (+ tests) samples the webview's pixels every 30 s while browsing (`shell_ios.m` `peli_shell_webview_probe`, `drawViewHierarchyInRect` 64×48 → mean luma; the shell paints #0e0d0c ≈ 13, a dead page is 0); three consecutive blanks recover by the same actions as a content-process kill (`Reload → ReloadHome → ErrorPage` over 10 min). It stays **inert until one sample has seen content** (a device whose pixels it can't read can never misfire) and skips while the app is inactive, the engine is active, or the route is `/player`. `peli_shell_webview_transparent` makes the webview see-through at startup, so the player no longer flips `web.opaque` mid-session (the attach/detach code in host_ios.m needed no change), and the iOS shell drops the `.grain` full-screen `mix-blend-mode` veil (`:root[data-platform="ios"] .grain::after { content: none }`).
- `5fafd9b` fix(ios) the retained ~330 MiB: `peli_host_detach` now deletes the FBO/renderbuffer and releases the EAGL context (a fresh one was created per session), `closeSession` sends mpv `stop` before destroying, and the AVAudioSession is deactivated on close. **Fact:** iOS's allocator returns freed large blocks to the footprint at once; macOS's does not (measured: 506 MiB alloc/free → 1.8 MiB on the iOS runtime, 505.7 MiB stuck on macOS) — never chase an iOS footprint drop on a Mac build.
- `1844f85` fix(diagnostics) the resume error burst: a cancelled binding call fails twice (caller's `CancelError`, then a `CancelledRejectionError` wrapping `context canceled` manufactured inside Wails' `Call`), and it surfaced through the window `unhandledrejection` listener in `lib/diagnostics.ts`; `ignorable()` now claims cancellations (`preventDefault`) while genuine failures still report.
- `78e0259` fix(player) `store: profile not found: 0`: `player-page.tsx`'s `?? 0` for a not-yet-loaded profile fed unguarded queries; `profileKnown()` (lib/profile.ts) now guards them all.

**Device-run checklist (next SideStore build):** scroll/browse until a black would have happened — the ring log should show `webview: blank, the page stopped painting` with an action and the screen back; after a play, `iosplayer: session closed footprint_before_detach_mib=… footprint_after_destroy_mib=… handles=0` with the next `memory:` line back near the browsing baseline; after an overnight background, no `frontend error … CancelledRejectionError` burst and no `store: profile not found: 0`. If blacks persist without `webview: blank` lines, the probe can't read that webview's pixels (the "staying inert" warning would say so) — then the lever is `peli_shell_webview_probe`'s method, not the thresholds.

**Next probes agreed with the user:** Safari Web Inspector on the black page (DOM responsive? `body` background? which route) discriminates 1/2 from JS hang; relaunch with `wails3 task ios:device:console` + live syslog while the user scrolls until black (HITL loop); check the iPhone's Hardware decoding setting (differential vs the iPad's off).

Related: [[crash-diagnostics]], [[ios-libmpv]], [[ios-sidestore]], [[virtualized-rows]], [[ipad-shell]].
