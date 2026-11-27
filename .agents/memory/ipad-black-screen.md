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

**CONFIRMED (red-div test, same day):** while black on `#/title/series/tt21056886`, a `position:fixed;inset:0;z-index:2147483647` red div appended to the body did **not** appear on screen (device screenshot: 0 red pixels, mean RGB (0,0,0)) — while the same page's JS ran and the DOM was intact. **Verdict: WebKit compositing death.** The page's frames stop being presented while the DOM, JS, input (web edge-back works) and all four processes stay alive; no `webViewWebContentProcessDidTerminate`, no jetsam, no crash, nothing recoverable fires. Navigating away (edge swipe) forces a recomposite and the screen returns. Triggers sit at heavy compositing: scrolling glass-heavy browse pages, opening a title (big hero + backdrop-filter), and playback (runtime `web.opaque=NO` + GLES layer insertion). Suspected contributors: `backdrop-filter` glass at ~2× the phone's pixels, the full-screen `.grain::after` `mix-blend-mode: overlay` veil (index.css ~835), the transparent webview, iPadOS 27.2.1. Fix directions (not built): a painting-liveness watchdog that reloads the webview on detected blanking (the existing #127 Terminated path doesn't fire for this), and/or reducing compositor load on iPad (drop the grain veil / fewer backdrop-filters on `isIOS() && regular width`).

**Next probes agreed with the user:** Safari Web Inspector on the black page (DOM responsive? `body` background? which route) discriminates 1/2 from JS hang; relaunch with `wails3 task ios:device:console` + live syslog while the user scrolls until black (HITL loop); check the iPhone's Hardware decoding setting (differential vs the iPad's off).

Related: [[crash-diagnostics]], [[ios-libmpv]], [[ios-sidestore]], [[virtualized-rows]], [[ipad-shell]].
