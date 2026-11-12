---
status: accepted
date: 2026-11-12
---

# iOS and iPadOS on Wails' experimental iOS target, debrid only

The first release for iPhone and iPad runs the same `main.go`, the same Go services and the unchanged React frontend in Wails v3's UIKit app: a `WKWebView` serving the embedded assets over the `wails://` scheme, with `@wailsio/runtime` for bindings and events. The audit that came before this ([`../ios-port-audit.md`](../ios-port-audit.md)) recommended a custom bridge; the user chose Wails' target knowing what it costs, and this records that choice, what was weighed, and the rules the build now follows.

## What was decided

- **Shell: Wails v3.1.0's iOS target** (experimental upstream, single window, Wails owns `UIApplicationMain` and the app delegate). No gomobile, no custom bridge. The upgrade from v3.0.0-beta.28 came first and changed nothing in behaviour (generated bindings were identical).
- **Player: libmpv on iOS**, our own build (extending `build/libmpv`, ADR-0041), drawn in a UIKit view under the transparent webview as the desktop does. Phase 5 builds it. Until then the iOS app binds a player that says it is not available yet.
- **iPhone and iPad together** in the first release. Minimum **iOS 17** (Wails' default is 15; the audit recommended 17).
- **Debrid only.** Torrent streaming, plugins (goja and the child process), watch parties, the updater and first-mouse handling are not compiled into the iOS build. App Review looks at what is in the binary, and each of those is code the review guidelines are hard on (peer-to-peer content, downloading and running code, self-update).

## Alternatives, with the audit's evidence

- **A custom gomobile bridge (the audit's pick).** A Go core as an xcframework, a SwiftUI shell, `WKWebView` with a message handler and a `@wailsio/runtime` shim. The probe built it (arm64 slice 15.8 MB for addons and Nuvio, 20.1 MB with the store), and it would give full control of the app delegate, scenes, PiP, AirPlay and the audio session. It costs a dispatcher over 138 called methods (gomobile can't export them one by one), a hand-made Events and Call.ByID shim, an asset scheme handler, a second Xcode project, and a second place where Wails' runtime semantics (cancellable promises, typed error codes) must be kept in step. Estimate 12–18 weeks with the player. Wails' target removes the bridge work and keeps Peli on the runtime it already uses. If the experimental target proves too limiting (below), this is where we go, and Phase 1's seams (`playback`, `secrets`, the tags) are the same for both.
- **Native SwiftUI screens over the Go core.** Best feel, and 25–40 weeks: the ranking engine (2.3 k lines), the addon client (1.1 k), resolve orchestration and the title and library rules (about 4 k lines of TypeScript in all) would be written twice, or run in JavaScriptCore. Two implementations of "what plays" is the maintenance cost the product can't carry.
- **AVPlayer only.** Fits PiP, AirPlay and Now Playing, and plays about one stream in ten. In the recorded corpus (7,390 unique streams from Torrentio, Comet, Peerflix and TorrentsDB, October 2026) 77 % are `.mkv` (81 % of the debrid-cached ones), 9 % `.mp4` and 6 % `.avi`; MP4 with H.264 or HEVC, the case AVPlayer handles, is 6.8 % (6.1 % cached). AVPlayer has no Matroska, DTS, TrueHD or AVI/XviD, and no ASS or PGS subtitles. It can come back later as a second engine for MP4 if PiP becomes a requirement.
- **VLCKit.** Plays the corpus out of the box (LGPL-2.1) in a week or two, but has its own state model with no `LoadOptions` parity (the Go-side track and caption rules would be mapped by hand), an estimated 80–100 MB (unverified) and another upstream. libmpv keeps the engine, the libass styling and the rules the desktop has, and ADR-0003 and ADR-0041 already say that only our own build ships.

## What the build does

`ios` implies the `darwin` build tag, so every `_darwin.go` file compiles for iOS unless it says `darwin && !ios`. The rules:

- **Tags, not forks.** `main.go` is the services both builds share (`peli`, `newPeli`, `services`). `main_desktop.go` (`!ios`) adds torrent, plugins, party, updates, first-mouse, the libmpv window host, media keys and the macOS window. `main_ios.go` (`ios`) adds the iOS window and lifecycle. `nosqlite.go` is `!ios` too, since the iOS build has no SQLite piece-completion store to leave out.
- **Secrets.** `internal/secrets/native_darwin.go` and its test are `darwin && !ios`. `native_ios.go` is the iOS backend, over Wails' Keychain (`application.Mobile.SecureSet/Get/Delete`, class generic password, `WhenUnlockedThisDeviceOnly`), through a small adapter (`mobile.go`) that has no tag and is tested on macOS. Items are filed as `service/key`.
- **Storage.** `store.DefaultPath()` uses `application.Mobile.StoragePath()` (Application Support in the app's container) on iOS and `adrg/xdg` elsewhere (`datadir_ios.go`, `datadir.go`).
- **The player.** The state, options, errors, reports and gate moved to `internal/playback`, with a `playback.Engine` (the controls the touch and desktop screens share) and a `playback.Sink` (state, time, ended and report back). `watching`, `tracking` and `party` import `playback`. `internal/player` keeps aliases, so the bound signatures and the generated bindings are unchanged. Everything with libmpv or AppKit in it is `!ios` (the `.m`, `.c` and `.h` files carry the constraint too, since Go would otherwise refuse C sources in a package with no cgo files). `service_ios.go` is the iOS `player.Service`: the same exported methods, backed by an Engine given with `player.UseEngine`, and failing with "not available yet" until then. A test (`TestIOSServiceHasTheDesktopMethods`) compares the method lists.
- **The services the app leaves out stay unbound.** The frontend's bindings are generated from the desktop app, and a bound method's id is a hash of its package path, type and method name. A stub that answers "not available on iOS" would have to be `internal/plugins.Service`, `internal/torrent.Service` and so on, which puts those packages in the iOS dependency list and breaks the boundary rule below. So the iOS app does not bind them, and a call to one fails with "unknown bound method id". The player is the exception because the screen needs it and the stub is cgo-free. The iOS Taskfile generates the bindings with no `-tags ios` for that reason, so one frontend build serves both.
- **Lifecycle.** `ApplicationDidBecomeActive` pulls, retries the pushes and imports tracked watches, as the desktop's window focus does. `ApplicationDidEnterBackground` runs `Pusher.FlushProgress` (which keeps the watched grace) inside a background-task window. The player's last report on going to the background, and the connection monitor and push timers across a suspend, are Phase 6.

## The boundary test

`ios_boundary_test.go` runs `go list -deps` for the main package with `GOOS=ios GOARCH=arm64 CGO_ENABLED=1 -tags ios` (no SDK needed) and fails if the list has `anacrolix`, `dop251/goja`, `go-llsqlite`, `pion/`, `internal/torrent`, `internal/plugins`, `internal/party`, `internal/updates`, `internal/firstmouse` or Wails' updater providers. It checks that `internal/player` compiles only `service_ios.go` and `types.go`, and no cgo, C or Objective-C file, in `internal/player` and `internal/secrets`. A second test checks that the desktop list still has all of them, so the first can't pass because the listing broke.

One exception is allowed: Wails' own `pkg/application` imports `pkg/updater` on every platform, so that package (not its providers, not Peli's `internal/updates`) is in the iOS binary whatever Peli does. Nothing calls it there. If App Review objects to inert updater code, the answer is a Wails patch or the bridge above, not a change in Peli.

Checked on the binary, too: `go tool nm` on the simulator build shows no `anacrolix`, `goja`, torrent, plugin, party, updates, first-mouse, pion or mpv symbols.

## Risks of an experimental target

- **Upstream stability.** The mobile API and build process may change before they are covered by the stability promise; Wails ships weekly. Pin the Go module and `@wailsio/runtime` to the same version and upgrade on purpose.
- **One window, and Wails owns the app delegate.** PiP, AirPlay routing, background audio and iPad scenes (multitasking, several windows) all need Objective-C inside a framework Peli doesn't control. The libmpv view behind the transparent webview is the same: layering has to be proved in Phase 5.
- **No App Store pipeline.** Wails says to archive and upload from the generated Xcode project (`wails3 task ios:xcode`).
- **Keychain.** `WhenUnlockedThisDeviceOnly` means a push in the background after a lock can't read the session. Phase 6 decides whether it needs `AfterFirstUnlock`, which Wails doesn't offer.
- **Go 1.27.1** is what this machine has; Wails recommends 1.27.3 for a `crypto/x509` fix. Upgrade the toolchain before a release.
- **Unverified at run time.** No simulator runtime was installed for this work: the app compiles, links and packages (an arm64 simulator `.app`), and nothing has launched. Web Workers and ES modules over `wails://` (the ranking worker), `http://` addons under App Transport Security, and `WKWebView` scrolling at 60 fps are Phase 2 to 4 checks.
- **The frontend still assumes a desktop.** Calls to the unbound services (updates and party at the root route, plugins when streams are listed) reject. Phase 2 adds an `isIOS` flag, hides what the build lacks, and makes the shell touch-first.

## Building it

`wails3 task ios:package` builds the simulator app into `bin/ios/peli.app` (Wails' layout puts the scaffolding in `build/ios/`, not a top-level `ios/`). `build/config.yml` has the `ios:` settings (bundle id `k22i.net.peli`, as the macOS app; version from `build/darwin/Info.plist`; iOS 17.0). A device build adds `IOS_PLATFORM=device CODESIGN_IDENTITY=… PROVISIONING_PROFILE=…`; the App Store path is `wails3 task ios:xcode`.
