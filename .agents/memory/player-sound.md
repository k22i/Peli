---
name: player-sound
description: "Player enhancements phase 4 (2026-11-11): store.Sound (profile + per title) and store.Audio (device), one lavfi af chain (dialoguenhance, af_biquads EQ, dynaudnorm night mode), libmpv build + smoke check for the filters, audio delay per session, volume-max 150, AudioDevices without a session, B key"
metadata:
  type: project
---

Phase 4 of the player enhancements ([[player-picture]] has the model).

- **Model:** `store.Sound` (dialogueBoost, nightMode, equalizer flat/voice/bass/treble/loudness) is `ProfileSettings.sound` and a `TitleAdjustments.sound` section; `store.Audio` (device = mpv `audio-device` name or `auto`, stereoDownmix, volumeBoost) is `DeviceSettings.audio`. Zero sections save as defaults, like the others. Audio delay is per session (`SetAudioDelay`, ±10 s, reset each Load), as subtitle delay is.
- **The chain (`sound.go`):** one `af` = `@sinag-sound:lavfi=[dialoguenhance…, eq…, dynaudnorm…]`; `""` when flat. dialoguenhance takes stereo and gives 3.0, so lavfi downmixes 5.1 first: surround comes out of the front (the UI says so). Boosting EQ presets start with a `volume=-NdB` cut, as there's no limiter in the build.
- **Night mode is dynaudnorm (f=150, g=7), not loudnorm:** on 60 s of 5.1, 0.2–0.4 s against 5.3 s of CPU, and loudnorm's live mode looks 3 s ahead (resampling to 192 kHz), which delays sound after seeks. Both keep timestamps, so a pts-based latency probe shows nothing; go by their buffering. The user's by-ear check is in the phase 4 click test.
- **Build (#92, #88):** `equalizer,bass,treble` (af_biquads.c) and `dialoguenhance` added to `ffmpeg_filters`; all LGPL, no configure GPL deps (`cropdetect` and `eq` are GPL). `smoke_darwin.c` sets the player's whole chain as `af` and fails on "No such filter" (it did on the old build). dylib 21,736 → 21,772 KiB, tar.xz unchanged at 8,608 KiB.
- **Output:** `audio-channels` stereo / `auto-safe`, `volume-max` 100/150 (observed → `State.volumeMax`; the bar's slider and ↑ go to it), `audio-device`. `Service.AudioDevices()` reads the session's `audio-device-list`, or makes a short-lived mpv (vo null, no logs) when nothing plays, for Settings. New binding `mpv.getNode`.
- **Frontend:** `lib/sound.ts`, `components/player/sound-tab.tsx` (Sound, Audio delay, This device), Settings › Playback › Sound. **B** toggles dialogue boost. settings.test.tsx partially mocks `@bindings/player` (AudioDevices) since the Sound group asks on render.
- Not gated by the watch party (sound doesn't move playback).
- Related: [[player-quality]], [[libmpv-build]], [[player-tracks]], [[watch-party]].
