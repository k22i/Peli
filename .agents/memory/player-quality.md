---
name: player-quality
description: "Player enhancements phase 3 (2026-11-11): store.Quality on DeviceSettings + per title, scaling presets, deband, CAS/FSR/Anime4K shaders embedded + licences, motion smoothing (macOS CVDisplayLink + display-fps-override), deinterlace, tone mapping off the EDR path, bench_darwin.c numbers"
metadata:
  type: project
---

Phase 3 of the player enhancements ([[player-picture]], [[player-framing]]).

- **Model:** `store.Quality` (scaling fast/balanced/high, deband off/low/medium/high, sharpen 0–10, upscaler off/fsr/anime4k, motionSmoothing, deinterlace auto/on/off, toneMapping auto/bt.2390/spline/hable/mobius/clip, targetPeak 0 or 80–1000) is **`DeviceSettings.quality`** (GPU-bound) and a `TitleAdjustments.quality` section. `qualityFor`: opts → title → device. The sheet's Quality tab says "Use on this device", not "for all titles".
- **Empty sections:** `SaveProfileSettings` / `SaveDeviceSettings` turn a zero Picture, Framing or Quality into the default, so older callers and tests with partial literals still save. `settings_test.go`'s `japanese` / `laptop` now carry every section (`japanese` also lacked the revamp's subtitle style).
- **mpv:** fast = mpv's `fast` profile, balanced = its 0.41 defaults (lanczos, hermite), high = `high-quality` (ewa_lanczossharp). Deband steps per level in `debandSteps`. Motion smoothing = `video-sync=display-resample`, `interpolation`, `tscale=oversample`. Tone mapping and target-peak come **last** in `qualityProps` and `showHDR` re-sets just those two: on the EDR path they are `auto`.
- **Shaders:** `internal/player/shaders` (embedded; `SOURCES.txt` has URL + sha256): Anime4K 4.0.1 Mode A (6 files), agyild's FSR and CAS ports of AMD FidelityFX. All MIT, no `//!COMPUTE` (Apple GL 4.1 has none). Written to `UserCacheDir/Peli/shaders/<hash>`; CAS is rewritten per strength (`cas-N.glsl`: `#define SHARPENING`, and its `//!WHEN` changed so it runs unless downscaling, as its notes suggest). Licences: `third_party/licences/anime4k-LICENSE.txt`, `fidelityfx-MIT.txt`, `shaderParts` in tools/notices.
- **macOS draw loop:** host method `smooth(on) float64` (every host; nullHost 0). `video_darwin.m` runs a CVDisplayLink (needs `-framework CoreVideo`) that calls `redraw()` each vsync and returns the nominal refresh rate → `display-fps-override`. `peli_video_stop` stops it. Windows' gpu-next and Linux return 0.
- **Costs (M1 Pro, 1080p → 3840×2160, `build/libmpv/smoke/bench_darwin.c`, load ~8):** fast 2.1 ms, balanced 5.6, high 14.3 (also 14 ms for 4K→4K: chroma), deband low/high 6.0/7.2 (4K source 8.9/12.1), CAS +0.5, FSR 11.1, Anime4K 17.5. A paused redraw only copies mpv's cached output, so the bench times new frames of a looping file (`untimed`, `video-sync=desync`). zsh doesn't split `$opts`: use `${=opts}`.
- **Gotchas:** `go run ./tools/notices` failed on coder/websocket's old ISC wording (fixed in policy.go); vi.mock factories can't use imports, so settings.test.tsx's device mock inlines its quality.
- Related: [[hardware-decoding-hdr]], [[libmpv-build]], [[player-picture]].
