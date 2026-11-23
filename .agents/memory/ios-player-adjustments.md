---
name: ios-player-adjustments
description: "2026-11-23: Picture & sound sheet on iOS — shared rules in internal/playback/adjust.go, iosplayer/adjust.go applies the safe subset, per-part features (framingFlips, fillFit, renderShaders, motionSmoothing, deinterlace, audioOutput, volumeBoost); not seen on a device"
metadata:
  type: project
---

The Picture & sound sheet (and Settings › Playback's picture/framing/quality/sound/HDR groups) show on iOS since 2026-11-23. The user asked for "only those possible, don't force features impossible on iOS".

- **Shared rules:** `internal/playback/adjust.go` holds the pure mpv builders and resolution rules both engines use (`PictureProps`, `FramingProps` + `FramingPanscan` + `FlipFilter` + `CropProp`, `ScalingProps`, `ToneProps`, `SoundChain`, `AudioChannels`, `PictureOf/FramingOf/SoundOf/QualityOf/AudioOf`). The desktop's `framingProps`/`qualityProps` rebuild the old property order from them.
- **iOS applies** (`internal/iosplayer/adjust.go`, at every Load and through `Set*`, forwarded by `service_ios.go`'s `adjustControls`): every picture setting; framing fit/aspect/zoom/pan/rotate + manual crop (`video-params/w,h` observed); scaling, deband, tone mapping (always the SDR path); dialogue boost/EQ/night mode `af`, stereo downmix; audio delay (observed into `State.audioDelay`).
- **Left out on iOS and why:** flips and deinterlace (a `vf` filter, where the 8-bit chain lives and which zero-copy can't take); `panscan`/Fill fit (the pinch owns it, [[player-gestures]]); CAS/FSR/Anime4K (never touch `glsl-shaders`, the chroma fix lives there, [[ios-libmpv]]); motion smoothing (no display-link loop); audio device + volume boost (`AudioDevices` must not be called on iOS).
- **Auto-crop followed** the same day: it is on iOS now, the same detection over this engine's frames — [[ios-autocrop]].
- **Frontend:** the features above are in `notOnIOS` in `lib/features.ts`; `playerPanels` now means only the desktop More menu (stats, A–B, screenshots, chapters). Touch entry = "Picture and sound" in `TouchMoreMenu`; gestures pause while the sheet is open; the sheet keeps clear of the safe areas.

**Why:** the user wanted these controls on the phone, but only where libmpv on GLES can do them without breaking zero-copy decoding.

**How to apply:** a new adjustment goes into `playback/adjust.go` first, then both engines; decide per part whether iOS can take it and add a feature flag if not. Owed: a device run (equalizer on GLES, high scaling cost on a phone, crop on a rotated video, the sheet's size on an iPhone in landscape). Related: [[player-picture]], [[player-framing]], [[player-quality]], [[player-sound]], [[ios-port]].
