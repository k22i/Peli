---
name: ios-libmpv
description: libmpv on iOS under Wails' webview — build-ios.sh xcframework, GLES render path, view layering, 10-bit HEVC hwdec gotcha
metadata:
  type: project
---

The iOS player uses libmpv, decided 2026-11-12 (ADR-0055). The spike was merged on 2026-11-13; see `spikes/ios-libmpv/README.md`, which has the coverage table and screenshots.

- `build/libmpv/build-ios.sh` builds a dynamic LGPL `libmpv.xcframework` from `sources.txt` with no source patches: about 20 MB per slice (device 9.6 MB zipped), with the device slice taking about 2.5 minutes warm and the simulator about 7 minutes cold. `-Dvideotoolbox-gl` stays off on iOS.
- Render path: libmpv render API on OpenGL ES with `ios-gl` VideoToolbox interop. mpv 0.41 has no Metal VO.
- Layering: `window.NativeWindow()` on iOS is the `WailsViewController`. A `CAEAGLLayer` view is inserted under its KVC `webView`, the webview is transparent, and CSS `backdrop-filter` shows the video through the controls.
- **Gotcha:** `hwdec=videotoolbox` rejects 10-bit (`p010`), so most HEVC needs `videotoolbox-copy`. Choose the mode per stream, or retry on `Format unsupported`.
- Simulator GLES runs in software, so judge speed only on a device. Picture-in-picture isn't possible on this path.

**Why:** 77–81 % of debrid streams are MKV, which AVPlayer can't play.
**How to apply:** Phase 5 productionises this into `internal/player` behind `playback.Engine`, estimated at 4–5 weeks. Related: [[ios-port]], [[libmpv-build]], [[player-service]].
