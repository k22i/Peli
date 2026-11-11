# M0 gate review: go, and the plan for M1–M3

Issue: [#8](https://github.com/k22i/Peli/issues/8) · Epic: [#1](https://github.com/k22i/Peli/issues/1) · Date: 2026-10-12

## Verdict

**Go.** Both risks that could have sunk the project are retired.

- **In-window playback works on all three OSes** with React controls drawn over the video and receiving input. Windows uses libmpv's `wid` embedding; macOS and Linux (X11 and Wayland) use libmpv's render API ([#2](spikes/mpv-wid-ipc.md), [#3](spikes/libmpv-cgo.md), [#4](spikes/mpv-render-api.md)).
- **Nuvio's backend is usable** from a third-party client with public inputs: both sign-in paths, all sync reads, and a push that showed up in Nuvio mobile ([#5](spikes/nuvio-backend.md)).
- The NFR targets hold with two restatements ([#7](spikes/baselines.md)), and our own stream ranking engine is a go ([#6](spikes/stream-ranking.md)).

No revised plan was needed. v1.0 is ~166 ideal dev-days of P0 work across three milestones ([below](#m1m3-scope-and-size)).

## Decisions

| ADR | Decision |
|---|---|
| [0001](adr/0001-libmpv-in-process-on-every-os.md) | libmpv in-process via cgo on every OS. No mpv child process. We accept losing crash isolation, and revisit if crash-free sessions fall below 99.5 % because of it. |
| [0002](adr/0002-video-host-per-os.md) | Video host per OS: Windows `wid` (HWND at the bottom); macOS `CAOpenGLLayer` drawn from our own queue; Linux X11 + Wayland `GdkGLTexture`s from our own render thread. Rendering never runs on the UI thread. X11 is confirmed once it's measured on a real GPU (#91). |
| [0003](adr/0003-mit-app-with-our-own-lgpl-libmpv.md) | The app stays MIT. We build our own trimmed, pinned **LGPL** libmpv per platform (#92), with no direct `vulkan-1.dll` import on Windows and relocatable on macOS. |
| [0004](adr/0004-nuvio-hosted-backend-go.md) | Use `api.nuvio.tv` through one sync module. Contract tests run against `NuvioMedia/self-host`. **Ask Nuvio during M1, before M2's sync work** (#93). If they say no, the custom-server backend (#34) takes over. |
| [0005](adr/0005-nfr-targets-after-m0.md) | Installers ≤ 60 MB **per architecture**, AppImage ≤ 100 MB. Cold start split into **first launch ≤ 5 s** and **later launches: Home ≤ 2 s**. Memory stays ≤ 250 MB (Linux provisional until #91). #41's virtualisation is required. |

Not an ADR: the stream ranking engine is our own TypeScript in a Web Worker, as #51 and #6 already say. Nothing there was a new trade-off.

## NFR targets, confirmed or revised

| Area | Target | Status after M0 |
|---|---|---|
| Installer size | ≤ 60 MB per installer, per arch; AppImage ≤ 100 MB | Revised (ADR-0005). Measured 14.5–39.5 MB Windows, 8.4–24.0 MB macOS per arch, AppImage 80 MB before libmpv |
| Cold start | Later launches: Home interactive ≤ 2 s from cache. First launch after install: first paint ≤ 5 s | Revised (ADR-0005). Shell paints in 0.5–1.0 s warm; Windows first launch 3.5–4.8 s |
| Idle memory | ≤ 250 MB with Home open | Confirmed for Windows / macOS; Linux provisional (#91) |
| Time to first frame | ≤ 3 s (debrid HTTP, 50 Mbps) | Confirmed; measured in #87 |
| Launch → first frame from Continue Watching | ≤ 15 s median | Confirmed; measured in #87 |
| Sync latency | Desktop progress visible in Nuvio mobile ≤ 30 s | Confirmed: 374 ms seen in #5. Note the server drops pushes inside its 15 s / 30 s thresholds (#30) |
| Stream ranking | ~200 streams ranked ≤ 16 ms; per-field accuracy targets from #6 | Confirmed (#51) |
| Play attempts reaching first frame, crash-free sessions, accessibility, privacy | ≥ 95 %, ≥ 99.5 %, keyboard + visible focus, no telemetry by default | Confirmed. The crash-free target now also guards ADR-0001 |

## M1–M3 scope and size

Estimates are **ideal dev-days** for one developer, also in the board's *Estimate (days)* field. They exclude review and waiting, so calendar time depends on capacity, and no dates are set yet. Buffers reflect risk: M1 carries the native video hosts, our own libmpv builds and CI on three OSes.

| Milestone | Exit criterion | Tickets | Estimate | With buffer |
|---|---|---:|---:|---:|
| **[M1 — Foundation and first play](https://github.com/k22i/Peli/milestone/5)** | A guest installs an addon by URL, searches, picks a ranked stream and plays it in-window with React controls on Windows, macOS and Linux, from CI-built artifacts with our LGPL libmpv | 23 | 74.5 d | +30 % ≈ 97 d |
| **[M2 — Nuvio account and sync](https://github.com/k22i/Peli/milestone/6)** | Sign in (email or QR), pick a profile, Home with Continue Watching, browse, Library. Desktop progress shows in Nuvio mobile within 30 s. Works offline and as a guest | 17 | 48 d | +20 % ≈ 58 d |
| **[M3 — Complete player and v1.0 release](https://github.com/k22i/Peli/milestone/7)** | Tracks, subtitles, next episode, HDR, media keys, settings, accessibility, diagnostics, signed installers within ADR-0005's limits, tagged v1.0 | 16 | 43 d | +20 % ≈ 52 d |
| **Total** | | **56** | **165.5 d** | **≈ 207 d** |

### M1 — Foundation and first play

| Ticket | Est. (d) | Notes |
|---|---:|---|
| #82 Decide product name | 1 | First: the module path, bundle IDs, keychain service name and app-data directory depend on it |
| #10 Clean up the Wails v3 scaffold | 1 | |
| #11 Frontend stack | 2 | |
| #92 Our own LGPL libmpv builds | 8 | **New.** Blocks #16's libmpv builds and #60 |
| #16 CI on three OSes | 3 | Uses #92's builds; Windows via mingw-w64 cross-compile |
| #18 Licensing | 1 | |
| #13 Design system | 5 | |
| #12 App shell | 3 | |
| #14 SQLite | 3 | Pure-Go driver keeps cgo to libmpv + the webview |
| #37 Addon protocol client | 4 | |
| #38 Addon manager | 3 | Local-only in M1; Nuvio sync arrives with #32 |
| #39 First-run empty state | 1 | |
| #44 Search | 3 | M1's way to reach a title. Home needs sync data, so it's M2 |
| #41 Virtualised rows and grids | 3 | Required for the memory target (ADR-0005) |
| #45 Title page | 4 | |
| #50 Query stream addons | 2 | |
| #51 Ranking engine | 6 | |
| #52 Stream picker | 3 | |
| #53 Play HTTP / debrid links | 2 | |
| #60 Player service + three video hosts | 10 | The biggest risk in M1 |
| #61 Player controls | 4 | |
| #91 Linux real-GPU measurement | 2 | **New.** Settles the X11 host and the Linux memory target before #60's Linux host is done |
| #93 Ask Nuvio about the hosted backend | 0.5 | **New.** Answer needed before M2 starts |

### M2 — Nuvio account and sync

| Ticket | Est. (d) | Ticket | Est. (d) |
|---|---:|---|---:|
| #15 Keychain | 2 | #28 Sync module | 5 |
| #33 Contract tests (self-host in CI) | 4 | #20 Email / password sign-in | 2 |
| #21 QR sign-in | 2 | #22 Session lifecycle | 3 |
| #23 Guest mode | 3 | #24 Profile picker | 2 |
| #25 PIN-locked profiles | 2 | #29 Delta-cursor pull | 3 |
| #30 Debounced push | 3 | #31 Offline launch | 3 |
| #32 Addon list sync | 2 | #64 Resume, progress, watched | 3 |
| #42 Home | 4 | #43 Movies / Shows / Anime | 3 |
| #46 Library | 2 | | |

### M3 — Complete player and v1.0 release

| Ticket | Est. (d) | Ticket | Est. (d) |
|---|---:|---|---:|
| #62 Audio / subtitle pickers | 3 | #63 Addon subtitles | 2 |
| #65 Next-episode countdown | 2 | #66 Hardware decoding + HDR | 4 |
| #67 Shortcuts + OS media keys | 4 | #54 Debrid accounts | 3 |
| #17 Settings | 2 | #89 Accessibility pass | 3 |
| #90 Diagnostics + crash reports | 3 | #77 Windows packaging | 3 |
| #78 macOS packaging | 3 | #79 Linux packaging | 4 |
| #80 Release pipeline | 2 | #88 CI installer-size check | 1 |
| #87 Release benchmarks | 3 | #81 Pre-launch review | 1 |

The **v1.0 — MVP** milestone was split into these three and closed. P0 still means "in v1.0", and the v1.x and Later milestones are unchanged. If Nuvio says no (#93), #34 (custom server, ~4 d) becomes P0 and moves into M2.

## Findings copied into tickets

Later tickets build from the findings docs, so each affected ticket now has a "From the M0 gate" section with the specifics and links. Tickets with player findings: #60, #61, #66, #67, #12, #16. Sync and account: #28, #29, #30, #31, #32, #33, #15, #20, #21, #22, #24, #25, #64. Streams: #37, #50, #51, #52, #53, #54. Platform and quality: #18, #77, #78, #79, #80, #81, #87, #88, #90, #41, #42, #14. Epics with changed targets: #76, #86.

## What M0 did not cover

These risks carry into M1–M3; each one is on a ticket:

- No real GPU on Windows or Linux, and no real GNOME / KDE desktop (#91, #87).
- HDR / EDR on screen, and HDR passthrough on Windows (#66).
- VO re-init, fullscreen, DPI scaling and multi-monitor for the Windows `wid` host (#60).
- What a libmpv crash does to the app (#60, #90).
- Token refresh and long-lived sessions against live (#22). Profile PINs (#25).
- Debrid services other than TorBox for stream cache markers (#51, #54).
