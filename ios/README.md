# Peli on iPhone and iPad

Peli's core runs on iOS and iPadOS 17 and later: sign in to Nuvio, pick a profile, browse and search your addons, play a debrid stream, and send watch progress back to Nuvio, SIMKL and AniList. It is the same app as the desktop one, not a port: the Go core and the React frontend are shared, built for iOS through Wails' experimental iOS target ([ADR-0055](../docs/adr/0055-ios-on-wails.md)).

This folder holds only this README. The iOS build lives where Wails expects it (see [Where things are](#where-things-are)).

Status on 2026-11-13: every core flow works in the iOS 27.2 simulator on iPhone and iPad. **It has never run on a real device**, and there is no App Store or TestFlight build yet.

## Requirements

- macOS with **Xcode 27.2** (the iOS 27.2 SDK and simulator runtime). There is no Simulator.app in Xcode 27.2; use `xcrun simctl`.
- **Go** 1.27.x (`go.mod` says 1.26.0; Wails recommends 1.27.3 or later), **pnpm** 11, and **`wails3` v3.1.0**: `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0`. It lands in `~/go/bin`, which must be on `PATH`.
- For the first build only, to build libmpv: `meson` and `ninja` (`pip install meson ninja`) and `nasm` (`brew install nasm`).

## Build and run in the simulator

```sh
export PATH="$HOME/go/bin:$PATH"
pnpm --dir frontend install

# libmpv.xcframework, about 10 minutes the first time, then cached in build/libmpv/.work
wails3 task ios:libmpv

# Boot a simulator, then build, install and launch the app on it
xcrun simctl boot "iPhone 17"            # or an iPad, e.g. "iPad Pro 11-inch (M5)"
wails3 task ios:deploy-simulator
```

`wails3 task ios:package` alone builds `bin/ios/peli.app` (about 36 MB, of which libmpv is 20 MB) without installing it. Logs: `wails3 task ios:logs`.

### Dev builds and the test rig

`wails3 task ios:run` builds a dev app (`k22i.net.peli.dev`, "Peli (Dev)"). Adding the `pelidev` build tag (`wails3 task ios:compile:ios EXTRA_TAGS=pelidev`, then bundle as `ios:run` does) adds a test rig that ships in no other build ([`dev_ios.go`](../dev_ios.go)), driven by `SIMCTL_CHILD_*` environment variables:

- `PELI_DEV_DIR`: a folder the app watches. JavaScript written to `cmd.js` there runs in the webview, and its answer is appended to `out.txt`. `play` and `ctl` files load a URL or pause, seek and stop the player.
- `PELI_DEV_GUEST=1` and `PELI_DEV_ADDONS`: start on the local Guest profile with the given addons, so playback writes nothing to Nuvio.
- `PELI_DEV_EMAIL` and `PELI_DEV_PASSWORD`: sign in once at launch.
- `PELI_NUVIO_URL`, `PELI_SIMKL_URL`, `PELI_ANILIST_URL`: point at fake servers (`tools/iosrig`).
- `PELI_HWDEC` forces the decoding mode; `PELI_VIDEO_SCALE=1` draws the video at 1× (much faster in the simulator).

The rig's recipes and its traps are in [`.agents/memory/ios-port.md`](../.agents/memory/ios-port.md).

## On a real device

Not yet done. What should work, untested:

1. Sign in to Xcode with an Apple ID. A free Personal Team is enough, but its apps expire after 7 days, and only 3 can be installed per device. Turn on Developer Mode on the device.
2. Make a development certificate and a provisioning profile for `k22i.net.peli` that includes your device.
3. `wails3 task ios:package IOS_PLATFORM=device CODESIGN_IDENTITY="Apple Development: …" PROVISIONING_PROFILE=path/to.mobileprovision`, then `wails3 task ios:deploy-device`.

**Don't use `wails3 task ios:xcode`**: the Xcode project Wails generates doesn't link or embed `libmpv.framework`, so the player is missing.

## What works

| Flow | Evidence |
|---|---|
| Sign in with email and password, or on the web in Safari; session in the iOS Keychain ([ADR-0057](../docs/adr/0057-ios-sign-in-and-keychain.md)) | `docs/ios/phase3-*`, `phase7-ipad-sign-in.png` |
| Profile picker, PINs, kids profiles and their addon allow-list | `phase3-*`, `phase7-iphone-profiles.png` |
| Home, Browse, Search and Title pages against real addons, sized for phone and iPad, long-press title menu, http artwork through a Go proxy | `phase4-*`, `phase7-iphone-{home,search,title}.png`, `phase7-ipad-title.png` |
| Streams: request and ranking (as on desktop, capped at 1080p without HDR on iOS); torrent-only results hidden | `phase5-*-picker.png`, `phase7-*-picker.png` |
| Resolve through a debrid addon and play with libmpv ([ADR-0058](../docs/adr/0058-ios-playback-engine.md)): MKV and MP4; HEVC 10-bit, H.264, Hi10p, AV1; E-AC-3, DTS, TrueHD, Opus, FLAC; SRT, ASS, PGS; HDR10 and Dolby Vision tone-mapped | [`docs/ios/playback-coverage.md`](../docs/ios/playback-coverage.md) |
| Touch player: tap for controls, seek bar, ±10 s, audio and subtitle menus (addon subtitles too), resume with Start over, the next-episode card, Back to the title | `phase5-*`, `phase6-start-over*.png`, `phase7-ipad-controls.png` |
| Progress and the 90 % watched rule to Nuvio; SIMKL and AniList scrobbling through the outbox; AniList sign-in in an in-app sheet ([ADR-0059](../docs/adr/0059-ios-suspension-offline-and-sign-in-sheet.md)) | live Nuvio and SIMKL checks, both undone (ADR-0059) |
| Going to the background mid-play: the player stops drawing, pauses and saves its position before the push; a call or unplugged headphones pause; being killed while suspended loses nothing queued | ADR-0059, `phase6-resume-paused.png` |
| Offline: progress queues, the offline pill shows, and coming back pushes it | `phase6-offline-pill.png` |

## Deferred

Not in the iOS build, by design. The App Store build contains no torrent code: build tags keep it out, and [`ios_boundary_test.go`](../ios_boundary_test.go) and the iOS CI check enforce it.

- Torrent streaming, the plugin sandbox and watch parties.
- Auto-update (the App Store would do this).
- The mini player, Picture in Picture, background audio, lock-screen controls and Now Playing.
- HDR/EDR output, and the picture, sound, quality and framing panels.
- The command palette, person pages and Library multi-select.

## Known gaps

- **No real-device run.** These are untested:
  - the zero-copy VideoToolbox path;
  - the fallbacks to copy-back and software decoding;
  - frame rates at 1080p and 4K, and the CPU cost of converting 10-bit to 8-bit for AV1 and Hi10p;
  - stopping GL drawing in the background (iOS kills apps that draw there; the simulator doesn't);
  - interruptions sent by the system;
  - device Keychain entitlements and signing.
- **The simulator is a poor guide to playback.** It draws video in software and has no hardware H.264 decoder. Heavy streams (such as a 46 GB, about 35 Mbit/s H.264 remux, or a 1080p HEVC on the iPad) can stay black while time advances and audio plays; a test clip draws on the same session. One failed VideoToolbox setup can leave the simulator drawing black until it reboots.
- **OpenGL ES is deprecated.** It works, but rules out Picture in Picture. Moving mpv to Metal through MoltenVK is the likely next step if a device shows problems.
- AniList hasn't been tested against a real account (fakes only); SIMKL and Nuvio have.
- Small things:
  - The Guest profile says "On this computer" on a phone.
  - The picker labels some debrid addons' cached links "P2P" (shared with desktop).
  - The Guest profile has no audio language, so a default-flagged dub can start first.
  - Some audio track names show in lower case.
- Split view and on-screen keyboard behaviour weren't exercised (there's no Simulator.app to drive them).
- Never run on GitHub: the separate [iOS workflow](../.github/workflows/ios.yml) has only been checked locally.

## Where things are

| Path | What |
|---|---|
| [`main_ios.go`](../main_ios.go) | The iOS `main`: services, lifecycle (background, return), the player engine |
| [`build/ios/`](../build/ios) | Wails' iOS build: `Taskfile.yml`, `main.m` with the UIScene delegate ([ADR-0056](../docs/adr/0056-uiscene-on-wails-ios.md)), Info and entitlements plists, icons |
| [`build/libmpv/build-ios.sh`](../build/libmpv/build-ios.sh) | Builds the dynamic, LGPL `libmpv.xcframework` (device and simulator), cached in `build/libmpv/.work` |
| [`internal/iosplayer/`](../internal/iosplayer) | The libmpv engine: an OpenGL ES view under the webview, decoding-mode choice, suspend and resume, audio session |
| [`internal/iosauth/`](../internal/iosauth) | The in-app sign-in sheet (`ASWebAuthenticationSession`) for AniList |
| `*_ios.go` (`main_desktop.go` and `!ios` files for the desktop) | Platform seams: Keychain (`internal/secrets`), storage path (`internal/store`), open URL (`internal/appinfo`), the player service (`internal/player`), the image proxy |
| [`frontend/src/lib/platform.ts`](../frontend/src/lib/platform.ts), [`features.ts`](../frontend/src/lib/features.ts) | `isIOS()` and the list of features hidden on iOS |
| [`ios_boundary_test.go`](../ios_boundary_test.go) | Proves the iOS build links no torrent, plugin, party or updater code |
| [`.github/workflows/ios.yml`](../.github/workflows/ios.yml) | Separate CI: simulator build, boundary test, symbol check |
| [`docs/ios/`](../docs/ios) | Screenshots per phase and the playback coverage table |
| [`docs/ios-port-audit.md`](../docs/ios-port-audit.md) | The Phase 0 audit and the architecture choice |

## Checks

```sh
go test -run '^Test(IOS|Desktop)Build' .   # the iOS boundary
go vet ./...                               # desktop
pnpm --dir frontend check
pnpm --dir frontend test && go test ./...  # the full suites
```

On 2026-11-13 both full suites failed exactly as they did before the port began: 60 frontend tests in 16 files, and 7 Go packages (`anilistaddon`, `backend`, `player`, `plugins`, `store`, `tools/notices`, and a flaky `tracking` test). The port added no new failures. Under heavy machine load some frontend tests time out; rerun those files alone.
