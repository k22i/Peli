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
- **8-bit to GLES (Phase 5, ADR-0058):** iOS GLES 3.0 has no 16-bit normalised textures; mpv then uses integer textures for 10-bit, which drew black/sheared in the simulator (copy `p010` and software `yuv420p10` alike). Zero-copy on a device uses `hwdec-image-format=nv12` (VideoToolbox outputs 8-bit, so the GLES interop's `p010` refusal never happens); copy and software modes run `vf=lavfi=[format=pix_fmts=nv12|yuv420p|…]` (8-bit passes, deeper converts). Set `vf` before `hwdec` when switching.
- **Mode chosen before the first frame:** device zero-copy, simulator `videotoolbox-copy` (`peli_is_simulator()`), software when Settings turns hardware decoding off; `PELI_HWDEC` overrides for testing. Fallback to copy in place on `Format unsupported` / `Mapping hardware decoded surface failed` / `hw-pixelformat=p010`; software retry before the first frame.
- **Simulator traps:** `CVOpenGLESTextureCache` returns -6683 for EVERY VideoToolbox frame (8-bit too), and after one failed mapping its GLES draws broken/black frames for the rest of the simulator boot, even in new processes: reboot the simulator (`simctl shutdown/boot`) after any zero-copy experiment. Frames were presented half-drawn (black, or cut along the quad diagonal) until `glFinish` before present (simulator only). `glReadPixels` on the drawable reads zeros there, so don't use it as a probe. iPad software frames can show 1-px grid seams. A fixture served from the Mac (`ffmpeg testsrc2`, HEVC 8/10-bit at 1448 and 1920 wide, ≥ 5 min long or it ends before the screenshot) is the reliable check.
- Simulator GLES runs in software (270–600 ms a frame), so judge speed only on a device. Picture-in-picture isn't possible on this path.

**Why:** 77–81 % of debrid streams are MKV, which AVPlayer can't play.
**How to apply:** Phase 5 built it as `internal/iosplayer` behind `player.UseEngine` (see [[ios-port]] Phase 5); coverage in `docs/ios/playback-coverage.md`. A device run is owed. Related: [[ios-port]], [[libmpv-build]], [[player-service]].
