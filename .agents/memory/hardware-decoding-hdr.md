---
name: hardware-decoding-hdr
description: "#66 hwdec from Settings per session (player.UseSettings, per-OS hwdecAPIs), HDR via video-params/gamma → host.canShowHDR/showHDR, macOS half-float EDR layer; the user's real db has hardware decoding OFF"
metadata:
  type: project
---

#66 (ADR-0039, "Hardware decoding and HDR"): `player.UseSettings(players, db)` in main.go; each session reads `DeviceSettings.hardwareDecoding` as it opens and sets `hwdec` to `hwdecAPIs` (per-OS const in `host_{darwin,linux,windows}.go`: `videotoolbox|vaapi|d3d11va,auto-safe`) or `no`. HDR: Go observes `video-params/gamma`; on `pq`/`hlg` and `host.canShowHDR()` it sets `target-trc=pq`, `target-prim=bt.2020` and calls `host.showHDR(true)`; `State.hdr` mirrors it. Only macOS can (half-float layer when the screen has EDR potential at attach); Windows leaves it to mpv (`target-colorspace-hint=auto`), Linux tone-maps.

**Why:** later player work (#67–#70, #91, #92) touches the same session options and host interface.

**How to apply:**
- The user's real `peli.db` has hardware decoding **off**: a dev-play run with a copy of it decodes in software (`hwdec ""`). Flip it in the scratch copy with `store.Open` + `SaveDeviceSettings` before checking VideoToolbox.
- The user's display has no EDR (potential 1.0), so the EDR layer only runs when forced (temporary `getenv` override of `g_edr` in `video_darwin.m`; never commit). A half-float layer must be tagged with a colourspace or SDR looks washed out.
- New host methods: every host, including `nullHost` and test hosts (`hdrHost` in `decoding_test.go`), implements `canShowHDR`/`showHDR`.
- Windows cross-vet in Docker needs `GOARCH=amd64` on this arm64 Mac, besides the flags in [[player-service]].
- Related: [[player-service]], [[player-tracks]].
