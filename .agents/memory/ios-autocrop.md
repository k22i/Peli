---
name: ios-autocrop
description: "2026-11-23: auto-crop (\"Remove black bars\") on iOS — the pure parts moved to internal/playback/autocrop.go, iosplayer/autocrop.go finds bars in screenshot-raw frames, iPhone skips over 1920×1088, the toggle is back everywhere"
metadata:
  type: project
---

"Remove black bars" now works on iOS too, through the same detection the desktop uses. Neither the simulator nor a device has run it yet (no frame was taken, nothing seen cropped).

- **Shared (no build tag):** `internal/playback/autocrop.go` holds `AutoCropAt` (the 1–120 s schedule), `AutoCropAgree` (3), `Frame` (bgr0: `W, H, Stride, Data` with `dark`), `DetectBars`, `LeastBars`, and `FrameFrom(v any)` (the `screenshot-raw` node map → `Frame`). The unexported constants (`blackLevel` 26, `blackShare` 0.985, `minBar` 0.6) moved with them, so the desktop's `TestDetectBars` now lives in `internal/playback/autocrop_test.go`. `internal/player/autocrop.go` keeps only `screenshot` (`commandResult` + `FrameFrom`) and `findBars`.
- **iOS (`internal/iosplayer/autocrop.go`):** `startAutoCrop`/`stopAutoCrop`/`findBars` mirror the desktop's, keyed on `Engine.loads` (bumped in `loadFile`) instead of `Service.file`; the goroutine is a `safego.Go`. `applyCrop` (adjust.go) now starts it when `Framing.AutoCrop`, else stops it, clears `State.AutoCrop` and sets the manual crop. `mpv.go` gained `commandResult` (`mpv_command_ret`) and `MPV_FORMAT_BYTE_ARRAY` in `nodeToGo` (the `byteArray` static helper), as the desktop has.
- **Memory cap:** a frame is w×h×4 bytes (4K = 33 MB). On an iPhone (`Phone()`, device.go) `findBars` returns before the first frame when `w*h > 1920*1088`, logging `iosplayer: auto-crop skipped` once; an iPad has no cap. The frontend says "On iPhone, for videos up to 1080p." in the toggle's hint and the Settings row.
- **Lock order:** `findBars` takes `e.mu` only to read `loads`, `videoW`, `videoH`, and drops it before `screenshot`/`setProperty`/`update`; `applyCrop` reads under `e.mu` and calls `startAutoCrop`/`stopAutoCrop`/`update` after releasing it. Both of those take `e.mu`, so nothing may call them inside an `e.update` closure or under `e.mu`.
- **Frontend:** `"autoCrop"` left `Feature`/`notOnIOS`, so the Framing tab's toggle and Settings › Playback's row show on both platforms again; `cropping` in framing-tab is `shown.autoCrop` again.

**Why:** the crop is mpv's `video-crop` (renderer-side, zero-copy), so the only cost is sampling frames; a phone's memory is what limits it, not the decoding.

**How to apply:** a shared detection change goes in `internal/playback/autocrop.go` and both engines pick it up; keep frames short-lived (a 4K frame is 33 MB) and raise the cap only with a device memory measurement. Related: [[player-framing]], [[ios-player-adjustments]], [[ios-libmpv]].
