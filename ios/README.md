# Peli on iPhone and iPad

Peli's core runs on iOS and iPadOS 17 and later: sign in to Nuvio, pick a profile, browse and search your addons, play a debrid stream, and send watch progress back to Nuvio, SIMKL and AniList. It is the same app as the desktop one, not a port: the Go core and the React frontend are shared, built for iOS through Wails' experimental iOS target ([ADR-0055](../docs/adr/0055-ios-on-wails.md)).

This folder holds only this README. The iOS build lives where Wails expects it (see [Where things are](#where-things-are)).

Status on 2026-11-13: every core flow works in the iOS 27.2 simulator on iPhone and iPad. Since 2026-11-17 a device build installs through SideStore ([On a real device](#on-a-real-device)), but there are no on-device results yet. There is no App Store or TestFlight build.

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

Peli goes onto an iPhone or iPad through [SideStore](https://docs.sidestore.io), which signs it with a free Apple ID and refreshes it on the device, so there's no weekly re-signing from the Mac. Set-up instructions checked against docs.sidestore.io and SideStore's source on 2026-11-17.

### Build

```sh
wails3 task ios:sideload          # production .ipa → bin/ios/peli.ipa, copied to iCloud Drive/Peli
wails3 task ios:package:ipa IOS_PLATFORM=device IOS_PRODUCTION=false   # debug .ipa (Wails' bridge tracing)
```

The `.ipa` is ad-hoc signed with only `get-task-allow`, and libmpv's `ios-arm64` slice is embedded in `Frameworks/`. SideStore throws that signature away and signs again, so no paid identity, certificate or profile is needed on the Mac. Test with the **production** build: Peli's own log lines (`slog`, for example `iosplayer: …`) print in both builds, while the debug build adds only Wails' internal tracing and turns Go inlining off, which skews CPU numbers. The Web Inspector is on in both (Safari → Develop → the device → Peli), because `DisableInspectable` isn't set.

### What SideStore changes, and why Peli doesn't mind

- **Bundle id:** it registers and installs `k22i.net.peli.<team id>` and rewrites `CFBundleIdentifier`. It also adds a `sidestore-…` URL type of its own. Nothing in Peli depends on the bundle id. Peli has no URL scheme, and the AniList sign-in returns to a loopback page (`http://127.0.0.1:47613/anilist`) in an in-app sheet. The Keychain service name `k22i.net.peli.secrets` is only an attribute.
- **Entitlements:** it signs with the free profile's entitlements, keeping only keys the app already has, plus `application-identifier`, the team id and `get-task-allow`. Peli asks for no `keychain-access-groups` and its `SecItem*` calls set no access group, so its items land in the default group, `<team>.k22i.net.peli.<team>`. That group stays the same across refreshes on the same Apple ID. Installing with a **different** Apple ID makes a different app: a new App ID, an empty Keychain and a new container.
- **Frameworks and extensions:** `libmpv.framework` is re-signed and needs no App ID. Each app extension would cost an App ID, but Peli has none. So Peli costs **one App ID**, and the same one on both devices.

### Free Apple ID limits

- **3 apps per device**, SideStore included: SideStore + Peli = 2 on each device.
- **10 App IDs a week** per account (SideStore's own error 1009). An App ID comes back 7 days after the app was installed or last refreshed, and can't be deleted. SideStore and Peli use 2, shared by both devices. A different bundle id (such as the `.dev` build) would be a new App ID.
- **7-day signatures:** SideStore refreshes them (below). An app that isn't refreshed in time stops opening until it is refreshed; its data is kept.
- **Certificates:** SideStore makes one per device ("SideStore - <name>'s <device>"). If the second device offers to **revoke** certificates, don't revoke the first device's, or the first device's apps stop opening.

### Install

Run [`build/ios/scripts/sidestore-setup.sh`](../build/ios/scripts/sidestore-setup.sh). It walks through every step only you can do, for the iPhone and then the iPad, and saves the device identifiers to `bin/ios/devices.env`. In short, per device:

1. **On the Mac, once:** install [iloader](https://iloader.app) (`iloader-darwin-universal.dmg`).
2. **LocalDevVPN** from the App Store, then Connect. SideStore needs it, together with Wi-Fi (mobile data isn't enough), every time it installs or refreshes. WireGuard and StosVPN are no longer recommended.
3. **iloader:** connect the device by cable and trust the Mac, sign in with the Apple ID (case-sensitive), select the device, then **Install SideStore (Stable)**. iloader also places the pairing file.
4. **On the device:** Settings → General → VPN & Device Management → trust the developer app. Then Settings → Privacy & Security → **Developer Mode** on; the device restarts.
5. **SideStore:** sign in, then in My Apps tap **7 DAYS** next to SideStore to finish its own setup before installing anything.
6. **Peli:** SideStore → My Apps → **+** → iCloud Drive → Peli → `peli.ipa` (download it in Files first).

The **pairing file** can expire after an iOS update or a reset, or at random. Errors such as AFC, 1006 or "no Wi-Fi/VPN" are fixed in iloader: Manage Pairing File → **Place** next to SideStore.

### Keep it signed

- iOS Settings → General → **Background App Refresh** on, and on for SideStore; in SideStore, Settings → **Background Refresh** on. It runs through iOS background fetch (when iOS decides), and LocalDevVPN has to be connected. Low Power Mode pauses it.
- Backstop: a **Shortcuts automation**: Automation → + → Time of Day (a daily time when the device is on Wi-Fi, such as overnight) → Run Immediately → the SideStore action **Refresh All Apps**. SideStore also has an **Install IPA** action.
- **To check it works:** a day later, SideStore → My Apps should show 7 DAYS again for SideStore and Peli. With Notify When Run on, the automation also posts a notification each time it runs.

### Ship a new build

`wails3 task ios:sideload`, then on each device install `peli.ipa` again from SideStore → My Apps → + (with LocalDevVPN on). Installing over the app keeps its data and Keychain. Each build gets a build number (`CFBundleVersion` = date and time), shown in SideStore. A self-hosted SideStore source (AltStore format, a JSON file with each version's `downloadURL`) would add one-tap updates, but it needs an https host the device can reach. For two devices that isn't worth it yet.

### Logs

With the cable connected (or the device paired over Wi-Fi) and Developer Mode on:

```sh
source bin/ios/devices.env
wails3 task ios:device:console DEVICE_ID=$IPHONE_ID
wails3 task ios:device:console DEVICE_ID=$IPAD_ID ENV='{"PELI_HWDEC":"videotoolbox-copy"}'
```

That launches Peli with stdout and stderr attached, so every `slog` line shows; Ctrl-C stops the app. `PELI_HWDEC` (`videotoolbox`, `videotoolbox-copy`, `no`) forces the decoding mode in any build. While a video plays, `iosplayer: stats` logs every 15 s: process CPU in percent of one core, decoding mode, pixel format, `container-fps`, `estimated-vf-fps`, dropped and delayed frames, and cache state. `iosplayer: first frame` names the codec and mode. A crash report is in Settings → Privacy & Security → Analytics Data (`peli-…`), or in Xcode → Devices and Simulators → View Device Logs. Don't use `ios:deploy-device`: it needs a paid identity.

### Crashes and shared logs

Peli keeps its own evidence on the device ([`internal/diagnostics`](../internal/diagnostics), #127):

- **Logs:** every `slog` line (and Wails' own) also goes to a ring of the last 2,000 lines. It is written to `logs/last.txt` in the app's data folder when the app leaves the front, on a recovered panic, after a WebKit kill and every 30 s. At launch the last run's file becomes `logs/previous.txt`.
- **Go crashes:** `debug.SetCrashOutput` writes a fatal panic's trace to `crash/<launch time>.txt`. The last 5 are kept. A launch after a crash logs `previous run crashed`.
- **Settings → About → Diagnostics** (iOS only) shows "Last crash" and has **Share logs**: the share sheet with this run's log (with a header: build, iOS version, model, free memory), the last run's log and the newest crash file. AirDrop it to the Mac, or save it to Files.
- **A WebKit kill** (iOS ends WebKit's content process for memory) is logged as `webview: content process terminated (n=…)`. The page reloads on the route it was on (the player goes back to its title). Twice within 30 s goes to Home with "Peli reloaded to free memory", and three times within 2 minutes shows a plain page with a Reload button.
- **Memory:** a `memory:` line every 30 s while the app is active (Go heap, `available` = `os_proc_available_memory()`, `footprint` = what iOS kills by), and `why=warning` on a memory warning, which also drops the frontend's unused queries.
- **The crash tests** live in a `pelidev` build, which needs no Mac and no `cmd.js`: `wails3 task ios:package:ipa IOS_PLATFORM=device IOS_PRODUCTION=false EXTRA_TAGS=pelidev` makes `bin/ios/peli.ipa` (a debug build, so Go's console logs are kept). Install it like any build. Settings → About then lists "Crash tests (dev build)": throw in render, reject a promise, allocate until killed, panic in Go, a recovered panic and a memory warning. In the simulator, `cmd.js` can call the same functions as `window.peliDev.<name>()`.

### First on-device checklist

Run these on the **Guest profile**, with your debrid addon added there. Nothing then reaches Nuvio, and SIMKL and AniList aren't connected. Resolving a stream adds it to TorBox: note what you play and delete those entries afterwards. Record the device model and iOS version, and the result, in [`docs/ios/device-run.md`](../docs/ios/device-run.md).

| # | Check | How | Pass when |
|---|---|---|---|
| 1 | Installs and opens | Through SideStore, on both devices | Welcome shows; `devicectl device info apps` lists `k22i.net.peli.<team>` |
| 2 | Zero-copy, 1080p HEVC 10-bit | Play one; watch the log | `first frame` hwdec `videotoolbox`, pixelformat `nv12`; `stats` vf-fps ≈ container-fps, no new drops |
| 3 | 1080p H.264 and 4K HEVC | Pick a 4K stream by hand (the ranking caps iOS at 1080p) | As in 2; note the CPU % |
| 4 | 10-bit to 8-bit CPU cost | An AV1 and a Hi10p (10-bit H.264) file | Smooth playback; note the CPU % and drops |
| 5 | Fallbacks | `ENV='{"PELI_HWDEC":"videotoolbox-copy"}'`, then `"no"`; and Settings → hardware decoding off | Picture in each mode; log names the mode |
| 6 | No GL drawing in the background | During playback: Home, then the lock button; wait 1 min; come back | Not killed (no `peli` crash report), paused at the same place, picture returns |
| 7 | System interruptions | A phone or FaceTime call, a timer going off, Siri, AirPods out | Pauses and doesn't resume by itself; `audio interrupted` / `output lost` in the log |
| 8 | LocalDevVPN on | Repeat 2 with the VPN connected | Plays as before |
| 9 | Keychain after a reboot | Save your TMDB key in Settings on Guest (TMDB checks it, so it must be a real one; the Mac has it in the keychain as `tmdb.api-key`); restart; unlock; open Peli | Key still there (the item is AfterFirstUnlockThisDeviceOnly) |
| 10 | Keychain and data across a refresh and a reinstall | Tap 7 DAYS next to Peli; then install a new `peli.ipa` over it | TMDB key, Guest addons and history still there |
| 11 | iPad layouts | Portrait and landscape on Home, Title, the picker, the player; rotate during playback | Regular shell, no clipped or overlapping controls |
| 12 | iPad split view and windows | With Peli on Home, then playing a video: Split View at 1/3, 1/2 and 2/3 (both sides); Slide Over; Stage Manager from the smallest window, a step at a time, to full; with the sidebar on (#138) and off; try to open a second Peli window (drag the icon from the Dock, or the App Exposé "+") | Compact shell (floating tab bar) below 700 pt wide or 500 pt tall, the centred bottom bar (CSS glass) or the sidebar above it, switching live as you drag; nothing clipped or overlapping at any size; the player fills each size; no second Peli window opens |
| 13 | On-screen keyboard | Search on both devices (#137: tap the Search circle, type, scroll the results, tap Search/Return, then dismiss); the TMDB key sheet (Settings › Addons & content › TMDB); the sign-in fields (don't submit) | The keyboard opens at once from the Search circle; the field and the first results stay visible; the last row scrolls above the keyboard; scrolling closes it; no gap or jump after it closes (nothing left shifted up); the tab bar hides while it is up and returns after |
| 14 | Background refresh | Next day | My Apps shows 7 DAYS for both apps; the automation ran |
| 16 | Hardware keyboard (iPad, #138) | Attach the Magic Keyboard. On Home: ⌘1–6, ⌘F and /, ⌘K (type a title, Return), ⌃⌘S (sidebar), ⌘, (Settings). Play something: Space, ←/→, ↑/↓, M, C, V, Z/X, [ ], ?, Esc; ••• → Keyboard shortcuts. Hold ⌘. Then detach it | Each key works; ⌘H, ⌘Tab and ⌘Space still do what iPadOS does; the overlay lists only the keys that work on iPad; ••• has Keyboard shortcuts and the bottom row a volume slider while attached; after detaching, ⌘K's palette is gone and ••• loses Keyboard shortcuts (no relaunch) |
| 17 | Trackpad (iPad, #138) | Magic Keyboard's trackpad or a mouse: hover cards, rows, chips, the bottom bar and sidebar; two-finger click a card at full screen and in a 1/3 split view; in the player move the pointer, click the picture, drag the volume slider | Cards lift and rows/chips highlight on hover; the context menu opens as a popover at the pointer at both widths (a finger's long press in the 1/3 split still gives the sheet); the player's controls show on pointer movement and hide when idle; a click on the picture pauses; no swipe gesture starts from a trackpad drag |
| 15 | iPhone rotation | With Rotation Lock off, then on. Turn the phone on Home and Title; play something holding the phone upright, then flat; turn it to both landscape sides; leave the player | Browsing stays upright; the player is landscape from the start however the phone is held, and flips to the other landscape side with the phone; leaving it turns the app upright |

To test signing in with your real account, signing in and then out is the only write: the session is created, then removed. A play on that profile writes progress to Nuvio. Undo it as in Phase 6 (episode menu → Mark unwatched; check with a fresh pull and an empty outbox).

### Paid account (later)

`wails3 task ios:package IOS_PLATFORM=device CODESIGN_IDENTITY="Apple Development: …" PROVISIONING_PROFILE=…`, then `wails3 task ios:deploy-device`. Not tried. **Don't use `wails3 task ios:xcode`**: the Xcode project Wails generates doesn't link or embed `libmpv.framework`.

## What works

| Flow | Evidence |
|---|---|
| Sign in with email and password, or on the web in Safari; session in the iOS Keychain ([ADR-0057](../docs/adr/0057-ios-sign-in-and-keychain.md)) | `docs/ios/phase3-*`, `phase7-ipad-sign-in.png` |
| Profile picker, PINs, kids profiles and their addon allow-list | `phase3-*`, `phase7-iphone-profiles.png` |
| Home, Browse, Search and Title pages against real addons, sized for phone and iPad, long-press title menu, http artwork through a Go proxy | `phase4-*`, `phase7-iphone-{home,search,title}.png`, `phase7-ipad-title.png` |
| Streams: request and ranking (as on desktop, capped at 1080p without HDR on iOS); torrent-only results hidden | `phase5-*-picker.png`, `phase7-*-picker.png` |
| Resolve through a debrid addon and play with libmpv ([ADR-0058](../docs/adr/0058-ios-playback-engine.md)): MKV and MP4; HEVC 10-bit, H.264, Hi10p, AV1; E-AC-3, DTS, TrueHD, Opus, FLAC; SRT, ASS, PGS; HDR10 and Dolby Vision tone-mapped | [`docs/ios/playback-coverage.md`](../docs/ios/playback-coverage.md) |
| Touch player (#130's compact chrome): tap for controls, a thin seek bar with a scrub label, ±10 s and Play in the middle, one Audio & Subtitles sheet (addon subtitles too, style, timing), More (speed for films, sleep timer, playback stats), Speed / Episodes / Next episode under the bar for a series, resume with Start over, the next-episode card, Back to the title | `phase5-*`, `phase6-start-over*.png`, `phase7-ipad-controls.png` |
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

- **No real-device results yet.** The SideStore build and its tooling are ready (2026-11-17, above), but these are still untested on hardware; [`docs/ios/device-run.md`](../docs/ios/device-run.md) collects the results:
  - the zero-copy VideoToolbox path;
  - the fallbacks to copy-back and software decoding;
  - frame rates at 1080p and 4K, and the CPU cost of converting 10-bit to 8-bit for AV1 and Hi10p;
  - stopping GL drawing in the background (iOS kills apps that draw there; the simulator doesn't);
  - interruptions sent by the system;
  - the Keychain after a reboot and across SideStore refreshes;
  - iPad split view and resized windows, and the on-screen keyboard.
- **The simulator is a poor guide to playback.** It draws video in software and has no hardware H.264 decoder. Heavy streams (such as a 46 GB, about 35 Mbit/s H.264 remux, or a 1080p HEVC on the iPad) can stay black while time advances and audio plays; a test clip draws on the same session. One failed VideoToolbox setup can leave the simulator drawing black until it reboots.
- **OpenGL ES is deprecated.** It works, but rules out Picture in Picture. Moving mpv to Metal through MoltenVK is the likely next step if a device shows problems.
- AniList hasn't been tested against a real account (fakes only); SIMKL and Nuvio have.
- Small things (#139): fixed in the code on 2026-11-17, waiting for a look on a device (see "Small fixes" below).
- Never run on GitHub: the separate [iOS workflow](../.github/workflows/ios.yml) has only been checked locally.

## iPad (#138)

- **Navigation at regular width** (700 pt wide and 500 pt tall or more): the sections float in a CSS-glass bar at the bottom centre: #129's CSS `TabBar` with `centred`, the iPhone's look, with the same `--tabs-float` clearance for pages, toasts and the selection bar. It was a capsule under the status bar until the first device run showed it overlapping the top bar. The sidebar button (`PanelLeft`, ⌃⌘S) at the top bar's leading end swaps the bar for a floating glass sidebar on the left (`components/shell/ipad-sidebar.tsx`): Search, the sections, then the profile's Nuvio Collections with their folders. The page and the top bar move over by `--ipad-sidebar`. The choice is kept per device (`lib/sidebar-choice.ts`, the webview's `localStorage`). CSS rather than native glass: decided by the user on 2026-11-18 (the #138 spike comment). Below the breakpoint the compact shell's floating tab bar (#129) takes over, live.
- **Hardware keyboard:** `shell.Service.HardwareKeyboard()` (GameController's `GCKeyboard.coalescedKeyboard`) and the `shell:keyboard {attached}` event (`GCKeyboardDidConnect`/`DidDisconnect`, `internal/shell/keyboard_ios.m`) feed `lib/input-devices.ts`. While one is attached, `feature("desktopControls")` and `feature("commandPalette")` are on (`useFeature` re-renders on the change): ⌘K, the player's shortcuts overlay (`?`, and ••• → Keyboard shortcuts). ⌘1–6, ⌘F and the player's keys always listen; the player skips the keys whose controls are desktop-only on iOS (`iosKeysOff`), and the overlay leaves them out. No ⌘ combo iPadOS uses (⌘H, ⌘Tab, ⌘Space) is claimed.
- **Pointer:** a trackpad or mouse (`any-pointer: fine`, or a mouse-type pointer event) is `pointerAttached()`. In the player a mouse-type pointer wakes the controls, clicks to pause and never starts a #131 gesture. A secondary click opens a card's context menu as a popover at any width (`ResponsiveContextMenu` checks `lastPointerType()`); a finger in a narrow window still gets #134's sheet.
- **Player:** at regular width #130's bottom row always shows (Speed moves into it from •••), with a volume slider while a keyboard or pointer is attached. #131's gestures are as on the phone.
- **Person pages** are on at regular width (`feature("people")`); **Library multi-select** at regular width with a hardware keyboard (it starts with ⌘- or Shift-click or Space, and has no touch way in). Both stay off on the iPhone and in a compact window.
- **One window:** `UIApplicationSupportsMultipleScenes` stays `NO` (`build/ios/Info.plist`). Wails drives one webview in one window, and the player, the tab bar and the shell bridge assume a single `WailsViewController`. A second scene would show a blank or duplicated app. Stage Manager and Split View still resize the one window freely (no `UIRequiresFullScreen`).

## Small fixes (#139)

- **Wording:** `thisDevice()` says "this iPhone" or "this iPad" (`deviceName()` in `lib/platform.ts`; an iPad that reports a Mac user agent counts through `maxTouchPoints`). The Guest profile, the "on this device only" note, the Keychain notes and the system sound, captions and light/dark descriptions use it; "Click to try again" is "Tap" on touch.
- **Meteor's cache marker:** `[TB🌩️]` is cached and `[TB☁️]` is not, recorded from a real TorBox response (`lib/ranking/fixtures/meteor-torbox.json`, six of 793 streams, URLs redacted). Shared with desktop.
- **Audio language:** `Store.SeedAudioLanguages` (called once per profile by `useSeedAudioLanguages`, iOS only) gives a local profile that has never saved settings the device's preferred languages. A Nuvio-synced profile, or one that saved anything, is left alone, so it never undoes a choice.
- **Language names:** `languageName` title-cases what `Intl.DisplayNames` returns and maps the ISO 639-2/B codes ("fre", "ger") engines don't know. A track's own title is left alone.
- **About:** Version reads `0.1.0 (20261117.1603)`: `appinfo.Build()` is the bundle's `CFBundleVersion`, which `ios:sideload` stamps as `YYYYMMDD.HHMM`.
- **Icon:** `build/ios/assets/AppIcon.appiconset` replaces Wails' generated set (the macOS tile, with transparent corners) at build time: a full-bleed 1024 icon in light, dark (amber on dark) and tinted (grayscale) versions. The SVG sources sit beside it and were rendered with headless Chrome (`--screenshot` at 1024×1024).
- **Launch screen:** `UILaunchScreen` names the `LaunchBackground` colour (`build/ios/assets/LaunchBackground.colorset`: `--background`, dark only since #143; `UIUserInterfaceStyle` is Dark in both Info plists, so the status bar, keyboard and system sheets follow); the old storyboard was never compiled and is gone. The webview starts clear and invisible over a window in that colour (`peli_quiet_webview` in `internal/iosplayer/host_ios.m`, called from `main.m`'s layout hook) and fades in on `appinfo.PageReady` (DOMContentLoaded), or after 4 s.
- **Touch CSS** (`index.css`, `data-platform="ios"` only): no selection, callout or tap highlight on the app; `touch-action: pan-x pan-y` on the page (no double-tap or pinch zoom); text fields and `[data-selectable]` (the synopsis) stay selectable.

## Connecting SIMKL and AniList on a phone (#133)

SIMKL and AniList tokens are per device and per profile, in each device's Keychain. Two ways to get them onto an iPhone or iPad:

- **Copy them from a device that has them** ([ADR-0061](../docs/adr/0061-device-pairing.md)): Settings › Integrations › Other devices. Both devices need the same Wi-Fi and the same Nuvio account. Nothing goes through a server: the transfer is end to end encrypted, and a code works once, for 3 minutes. **The camera always scans:**
  - **Mac → iPhone/iPad:** on the Mac, *Add to another device*, pick the profiles (and the TMDB key), *Show code*. On the phone, *Copy from another device* opens the camera; scan, check the summary, *Copy*.
  - **iPhone/iPad → Mac:** on the Mac, *Copy from another device* shows a code. On the phone, *Add to another device* › *Scan a Mac's code*. The Mac shows the summary; *Copy*.
  - **iPhone → iPad:** like Mac → iPhone, with the iPhone showing the code.
  - **Mac → Mac:** the sending Mac also shows six words; type them into *Copy from another device* on the other Mac.
  - Profiles match by Nuvio profile; others (Guest) are picked by hand or skipped. Kids profiles are never copied. Afterwards each profile imports its history, as after a sign-in.
  - The first scan asks for the camera, the first connection for Local Network. If either is off, the error has an *Open Settings* button.
- **Sign in on the phone itself:** SIMKL's dialog says "Approve this code on any device, like your Mac", shows the code large and has *Copy code* (approve at simkl.com/pin anywhere). AniList opens its sign-in sheet in the app.
- **Disconnecting a copied SIMKL grant** asks *On this device only* (the other devices keep scrobbling) or *Everywhere* (revokes it; the others then show "SIMKL was disconnected on another device"). AniList can't be revoked from Peli, so Disconnect only forgets it here.
- Code: `internal/pairing` (bundle, matching, seal, LAN server and client, CPace and Bonjour for the phrase), `internal/tracking/share.go` (export and adopt, never bound), `internal/shell` (`ScanQR` with AVFoundation, `OpenAppSettings`), `frontend/src/components/settings/pairing-dialogs.tsx`.

## Where things are

| Path | What |
|---|---|
| [`main_ios.go`](../main_ios.go) | The iOS `main`: services, lifecycle (background, return), the player engine |
| [`build/ios/`](../build/ios) | Wails' iOS build: `Taskfile.yml`, `main.m` with the UIScene delegate ([ADR-0056](../docs/adr/0056-uiscene-on-wails-ios.md)), Info and entitlements plists, icons |
| [`build/libmpv/build-ios.sh`](../build/libmpv/build-ios.sh) | Builds the dynamic, LGPL `libmpv.xcframework` (device and simulator), cached in `build/libmpv/.work` |
| [`internal/iosplayer/`](../internal/iosplayer) | The libmpv engine: an OpenGL ES view under the webview, decoding-mode choice, suspend and resume, audio session |
| [`internal/iosshell/`](../internal/iosshell) | Peli's additions to Wails' shell: reloading after a WebKit kill, memory readings, the share sheet ([`internal/diagnostics`](../internal/diagnostics) decides what they do) |
| [`internal/iosauth/`](../internal/iosauth) | The in-app sign-in sheet (`ASWebAuthenticationSession`) for AniList |
| [`internal/pairing/`](../internal/pairing) | Copying SIMKL, AniList and the TMDB key between devices over the local network ([ADR-0061](../docs/adr/0061-device-pairing.md)) |
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
