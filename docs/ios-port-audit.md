# iOS / iPadOS port audit (Phase 0)

Date: 2026-11-12. Repo at `382f1b2` (`main`). No code was changed. Everything below was measured on this
machine unless marked **unverified**. The scope is the one the user gave: auth, profiles/PIN/kids,
Home/Browse/Search/Title over the addon client and manager, debrid stream request → ranking → resolve →
touch player (resume, tracks, next episode), Nuvio progress and the SIMKL/AniList outbox with
offline/reconnect. Out of scope: torrent streaming, plugins, watch party, mini player, HDR/EDR,
picture/sound/quality/framing, auto-update, command palette, person pages, library multi-select.

## Summary

- **The user is wrong about Wails.** Wails v3 `v3.0.0-beta.28` (the version in `go.mod`) has an iOS target:
  `IOS.md`, ~40 `*_ios.go/.m/.h` files, an `ios:*` Taskfile, an Xcode generator and an `examples/ios-poc`.
  It is labelled experimental upstream. See §5.
- **The Go core can be compiled for iOS and bound with gomobile.** A throwaway probe built an
  xcframework for `iossimulator` and `ios` (arm64 slice 15.8 MB for addons + nuvio; 20.1 MB with the
  store). Not everything is portable as written: 7 of 24 packages fail on iOS today (§1, §4).
- **Two blockers are not in the Go packages' own code.** (1) `GOOS=ios` also sets the `darwin` build tag, so
  every `_darwin.go` file (AppKit, `Security.framework` macOS-only calls) is compiled for iOS.
  (2) The player (libmpv + AppKit/Cocoa host) is welded to Wails and to the `Report`/`Watching` types that
  `watching` and `tracking` import.
- **Most of the product logic lives in TypeScript, not Go** (ranking, addon client, resolve orchestration,
  title/library rules). That decides the architecture: reuse the React frontend (§6).
- **Playback is the real risk.** About 77–81 % of the recorded streams are `.mkv`, 8–9 % are `.mp4` (§6.6).
  AVPlayer alone will not cover the product; libmpv or VLCKit is needed on iOS.
- **No iOS simulator runtime is installed** on this Mac (`simctl list runtimes` is empty), so nothing
  was run on a simulator or device. Everything below is compile and link level.

## 1. Package table

Method: `go list ./internal/...`, `go list -f '{{.Imports}}'`, `go list -deps | grep wailsapp`,
`CgoFiles`/`IgnoredGoFiles`, then `go build` per package for `GOOS=ios GOARCH=arm64`:

```
# A: CGO_ENABLED=0
GOOS=ios GOARCH=arm64 CGO_ENABLED=0 go build ./internal/<pkg>
# B: device SDK (wrapper script runs: xcrun --sdk iphoneos clang -arch arm64 -miphoneos-version-min=16.0)
CGO_ENABLED=1 GOOS=ios GOARCH=arm64 CC=<wrapper> CGO_CFLAGS="-isysroot $(xcrun --sdk iphoneos --show-sdk-path) -arch arm64 -miphoneos-version-min=16.0" \
  CGO_LDFLAGS="<same>" go build ./internal/<pkg>
# C: simulator SDK (same, iphonesimulator, -mios-simulator-version-min=16.0), packages that passed B
```

`GOOS=ios go vet` with `CGO_ENABLED=0` fails for every package with
`ios/arm64 requires external (cgo) linking, but cgo is not enabled`, so **iOS needs cgo on**.
`nuviotest` was left out of the build loop (test helper, same imports as `nuvio`).

Columns: **Wails** = D (imports it directly) / T (only through `go list -deps`, 23 Wails packages come in
through `store`, 25 with `updates`). **OS** = build-tagged or `_darwin/_windows/_linux` files. **cgo/exec** =
`CgoFiles`, `import "C"`, `os/exec`. **iOS build** = results of A / B / C above (✓ builds, ✗ fails).

| Package | Wails | OS-specific | cgo / exec | Core scope? | iOS build A / B / C | What iOS needs |
|---|---|---|---|---|---|---|
| `main` | D (application, events, updater) | `nosqlite.go` tag; `runtime.GOOS` for the frameless window | – (but pulls every package below) | no, replaced by a mobile entry | – | New entry; `main.go` stays desktop-only |
| `account` | D (`ServiceStartup`, `RegisterEvent`) | `qr.go` maps `runtime.GOOS` to a device name (no `ios`) | – | **yes** | ✗ / ✗ (via `secrets`) / – | Seam: event emitter (already injected as `emitProfiles`/`onEnded`, only wired in `ServiceStartup`); split Wails glue file; add `ios` to the OS name map |
| `addons` | – | – | – | **yes** | ✓ / ✓ / ✓ | none |
| `anilist` | – | – | – | **yes** | ✓ / ✓ / ✓ | none |
| `anilistaddon` | – | – | – | **yes** | ✓ / ✓ / ✓ | none |
| `animelist` | – | – | – | **yes** | ✓ / ✓ / ✓ | none (cache dir passed in) |
| `appinfo` | – | – | – | **yes** | ✓ / ✓ / ✓ | none |
| `backend` | T (via `store`) | – | – | **yes** (contains `Parties`, unused on iOS) | ✗ / ✓ / ✓ | Falls out once `store` is split from Wails |
| `firstmouse` | – | `_darwin.go` (AppKit `Cocoa/Cocoa.h`), `_other.go` | cgo | no | ✗ / ✗ / – | Constraint must become `darwin && !ios`; mobile entry never imports it |
| `licences` | – | – | – | yes (Settings › About) | ✓ / ✓ / ✓ | none |
| `markers` | T | – | – | optional (skip intro) | ✗ / ✓ / ✓ | none beyond the `store` split |
| `nuvio` | – (`coder/websocket` for realtime) | – | – | **yes** | ✓ / ✓ / ✓ | none |
| `nuvio/nuviotest` | – | – | – | tests only | not built | none |
| `party` | D | – | – | no | ✗ / ✗ / – | Not imported on iOS |
| `player` | D (window host, `events`) | `host_{darwin,linux,windows}`, `media_*`, `mini_*`, `captions_*`, `reveal_*`, `.m`/`.c` | cgo (libmpv, Cocoa), `os/exec` | **seam** | ✗ / ✗ (`Cocoa/Cocoa.h`) / – | Split into portable (`State`, `LoadOptions`, `Report`, `Watching`, track/caption rules, ended codes) and an engine interface; mpv+AppKit engine stays desktop, iOS engine is native |
| `plugins` | T | `syscall` | `os/exec` (child = own binary), goja | no | ✗ / ✓ / ✓ | Not imported on iOS (the process model cannot work there) |
| `secrets` | – | `native_darwin.go` (macOS `SecCodeRef`), `native_other.go` (`!darwin`), `unavailable_linux.go` | cgo, `go-keyring` | **yes** | ✗ / ✗ / – | `osBackend` is undefined on `ios` (`_other` is `!darwin`, `_darwin` is cgo macOS-only). Needs an iOS `backend` implementation (Keychain `SecItem`, through a Swift callback or cgo) |
| `simkl` / `simkltest` | – | – | – | **yes** | ✓ / ✓ / ✓ | none |
| `store` | D (`service.go`: `ServiceStartup`, `ServiceOptions`) | none; path via `adrg/xdg` + `$PELI_DATA_DIR` | – (pure-Go bbolt) | **yes** | ✗ / ✓ / ✓ | Split `service.go` Wails glue behind a tag; explicit data dir from the app container |
| `streams` | – | – | – | **yes** | ✓ / ✓ / ✓ | none |
| `syncer` | D (events) | – | – | **yes** | ✗ / ✓ / ✓ | Emitter seam, same pattern as `account` |
| `torrent` | T | – | anacrolix; SQLite is cgo unless `-tags nosqlite` | no | ✗ / ✓ (warning: `gethostuuid() is disabled`) / ✓ | Not imported on iOS |
| `tracking` | D | – | – | **yes** | ✗ / ✗ (via `secrets`) / – | Emitter seam; needs `player.Report`/`Watching` moved out of `player` |
| `updates` | D (`application`, `updater`) | `installed_darwin.go`, `_other.go` | `os/exec` | no | ✗ / ✓ / ✓ | Not imported on iOS (App Store updates) |
| `watching` | T | – | – | **yes** | ✗ / ✗ (via `player`) / – | Same `Report`/`Watching` extraction |

### Counts (24 internal packages built + `nuviotest` + `main`)

- **Portable and UI-free, no Wails anywhere in their deps, no OS code, no cgo/exec:** 11
  (`addons`, `anilist`, `anilistaddon`, `animelist`, `appinfo`, `licences`, `nuvio`, `nuviotest`, `simkl`,
  `simkltest`, `streams`).
- **Portable code that Wails reaches only through `store`/`player`:** 3 more (`backend`, `markers`,
  `watching`). They become portable when `store` loses its Wails import and `Report` leaves `player`.
- **Import Wails directly:** 8 (`account`, `party`, `player`, `store`, `syncer`, `tracking`, `updates`, `main`).
  Of those, 4 are core packages (`account`, `store`, `syncer`, `tracking`), and in each the import is
  an event emitter or the `ServiceStartup` signature (about a screen of code).
  Wails **transitively** (through `go list -deps`): 13 packages.
- **OS-specific code:** 4 (`firstmouse`, `player`, `secrets`, `updates`), plus `runtime.GOOS` uses in
  `account/qr.go`, `player/style.go`, `player/reveal_other.go`.
- **cgo or child processes:** 5 (`firstmouse`, `player`, `secrets` use cgo; `player`, `plugins`, `updates` use
  `os/exec`). `torrent` is indirect (SQLite cgo unless `nosqlite`).
- **Compile results (24 built):** A (`CGO_ENABLED=0`): 10 ✓, 14 ✗. B (device SDK, cgo): 17 ✓, 7 ✗
  (`account`, `firstmouse`, `party`, `player`, `secrets`, `tracking`, `watching`). C (simulator SDK): all 16 that
  passed B passed again (the 17th, `simkltest`, was not rebuilt).
- **In the iOS core:** 16 packages (`account addons anilist anilistaddon animelist appinfo backend licences
  markers nuvio simkl store streams syncer tracking watching`) ≈ 16.7 k lines of non-test Go. Out of scope:
  `party` 2.7 k, `plugins` 2.8 k, `torrent` 1.1 k, `updates` 0.7 k, `firstmouse` 0.04 k; `player` 4.8 k is split.

### Findings behind the table

1. **`ios` implies `darwin`.** Go sets both tags for `GOOS=ios`. `native_darwin.go` (uses macOS-only
   `SecCodeRef`: `error: use of undeclared identifier 'SecCodeRef'` for iOS), `firstmouse_darwin.go`,
   `host_darwin.go`, `updates/installed_darwin.go` all compile for iOS unless constrained to
   `darwin && !ios`. The `_other.go` counterparts (`!darwin`) are then excluded too, giving
   `internal/secrets/secrets.go:58:41: undefined: osBackend`. Wails' own `IOS.md` says the same.
2. **SQLite driver: none.** The store is **bbolt** (`go.etcd.io/bbolt`, ADR-0006), a pure-Go file
   database named `peli.db`. No cgo, nothing for gomobile to worry about. (SQLite only appears through
   anacrolix/torrent: `github.com/go-llsqlite/crawshaw` is cgo unless `-tags nosqlite`.)
3. **Keychain.** `internal/secrets` uses `github.com/zalando/go-keyring` (on macOS it shells out to
   `/usr/bin/security`; a Developer-ID build uses `native_darwin.go`, cgo calling `Security.framework`
   directly). It already has a `backend` interface (`osBackend()`), which is the seam for an iOS
   backend. `MaxSize` 2560 bytes and the key pattern stay.
4. **How the out-of-scope parts are wired** (`main.go`, 231 lines): all services are built in `main` and
   passed to `application.NewService(...)`: `updates`, `plugins` (child process, `plugins.ServeChild()` first
   thing in `main`), `torrent`, `party` (+ `party.UsePlayer`, `player.GateWith`) and `player`. Cross-package
   wiring is by `UseX`/`ReportTo` functions, so a mobile entry that simply doesn't call them works. **Build
   tags that exist:** only `nosqlite.go` (`production && cgo && !nosqlite`, a deliberate release-build
   failure) and the OS file suffixes/`_other.go` pairs. There is no `ios` or `mobile` tag.
5. **Wails event wiring pattern.** Each service has `emit` func fields assigned in `ServiceStartup` only if
   `application.Get() != nil` (`account`, `syncer`, `tracking`, `party`). `application.RegisterEvent[T]` runs in
   `init()` for typed events. So an injected emitter already exists; what is missing is a way to compile
   the package without importing Wails.
6. **HTTP/CORS fallbacks live in:** `internal/addons` (`Service.Fetch`, used when the webview's fetch
   throws, including a built-in `peli://` scheme for AniList-backed addons), `internal/markers`
   (IntroDB: "answers browsers from its own site only (CORS), so Go asks"), `internal/streams`
   (`Resolve`), and everything for Nuvio, SIMKL and AniList (Go only).
7. **Paths.** `store.DefaultPath()` = `adrg/xdg` `DataHome`/Peli/peli.db or `$PELI_DATA_DIR`; `animelist` and
   `torrent` use the same. On iOS pass the app container path explicitly (`xdg` on iOS is **unverified**).

## 2. Bridge surface (frontend)

Commands: `grep` of `@bindings/…` and `@wailsio/runtime` imports in non-test `src/`, and a script that compared
each generated `bindings/**/service.ts` export with `<Alias>.<Method>` calls. Method counts are regex-based
(±3).

**Bindings.** 16 generated service modules, **169 methods**, about **138 called** from non-test code.
Bindings are generated as `$Call.ByID(<numeric id>, …)` through `@wailsio/runtime`;
`wails3 generate bindings -names` switches them to `Call.ByName` (flag exists in the installed CLI).

| Module | Methods (generated / called) | iOS |
|---|---|---|
| `store` | 42 / 37 | **in** |
| `account` | 27 / 25 | **in** (QR sign-in, PIN, kids, addons) |
| `tracking` | 15 / 9 called by regex, `Start*`/`Wait*` device-flow calls are used by the dialogs | **in** |
| `streams` | 1 / 1 (`Resolve`) | **in** |
| `addons` | 2 / 1 (`Fetch`) | **in** |
| `syncer` | 4 / 3 | **in** |
| `animelist` | 2 / 2 | **in** |
| `secrets` | 4 / 4 (tokens, TMDB key) | **in** (iOS Keychain impl) |
| `appinfo`, `licences` | 1 / 1 each | **in** |
| `markers` | 1 / 1 | in (optional) |
| `player` | 33 / ~31 | **split**: in: `Load`, `Stop`, `SetPaused`, `Seek`, `Scrub`, `SetVolume`, `SetMuted`, `SetSpeed`, `SetAudioTrack`, `SetSubtitleTrack`, `SetSubtitleDelay/Size/Style`, `AddSubtitle`, `Snapshot`, `SetNowPlaying`, `SetSecondarySubtitleTrack`; out: `SetMini`, `SetFraming`, `SetPicture`, `SetQuality`, `SetSound`, `SetAudio`, `SetAudioDelay`, `AudioDevices`, `Stats`, `Screenshot`, `ShowScreenshot`, `SetLoop`, `FrameStep`, `SetFullscreen`, `SystemCaptions` |
| `plugins` | 10 / 9 | out |
| `torrent` | 6 / 4 | out |
| `party` | 17 / 6 | out |
| `updates` | 3 / 3 | out |

Roughly 84 called methods are fully in scope, plus 17 of `player`'s; about 36 are out. Out-of-scope modules are still
imported by shared screens (picker, player page, Settings), so on iOS they need stubs that fail with a
clear error, and their UI must be hidden by a platform flag.

**Events (Go → JS).** 13 custom events, all via `Events.On`; the frontend never calls `Events.Emit`.

- in scope (9): `player:state`, `player:time`, `player:ended`, `sync:pulled`, `sync:connection`,
  `account:session-ended`, `account:profiles-changed`, `tracking:imported`, `tracking:changed`.
- out (4): `updates:status`, `party:state`, `party:notice`, `party:chat`.
- Desktop window chrome (3 listeners on `Events.Types.Common.WindowMaximise/UnMaximise/Restore`,
  `shell/window-controls.tsx`): out.

**Other Wails runtime calls.**

- `Browser.OpenURL` ×8 (title page trailer, tracking dialogs, addon dialogs, QR sign-in) → in scope; map to
  `UIApplication.open` / `SFSafariViewController`.
- `Window.ToggleMaximise/Minimise/Close/IsMaximised` (title bar), `Window.SetBackgroundColour` (theme) →
  no-ops on iOS.
- `System.IsMac/IsWindows/IsLinux` (`lib/platform.ts`) → needs an `isIOS`.
- No clipboard, no dialogs, no screens API. `main.tsx` imports `@wailsio/runtime` for its side effect (the
  runtime handshake).

**Direct network from the webview (not through Go).**

- `lib/addon-protocol/client.ts`: `fetch` to each addon host; on a `TypeError` (CORS or network) it
  falls back to Go `Addons.Fetch`. This is already the CORS escape hatch.
- `lib/tmdb.ts`: `fetch('https://api.themoviedb.org/…')` with the user's key (from the keychain).
- `<img>` loads of posters/backgrounds from addon and TMDB hosts.
- Through Go: Nuvio (Supabase/PostgREST, realtime), SIMKL, AniList, anime list, IntroDB (`markers`),
  stream resolve, and addons that fail CORS.

Under a WKWebView custom-scheme origin these behave as cross-origin requests, as in Wails desktop
(`wails://wails` on macOS), so addons that send `Access-Control-Allow-Origin` work and the Go fallback covers the rest. Two iOS-specific
things are **unverified**: App Transport Security applying to webview `fetch` of `http://` addons (Go's
`net/http` is not subject to ATS, so the Go fallback is a safe route), and Web Workers (the ranking worker)
loading from a custom scheme.

Frontend size: ~40 k lines of non-test TS/TSX. The logic that decides "what plays" is in it:
ranking (2.3 k lines), addon protocol client (1.1 k), resolve orchestration, title/library/calendar rules,
next-episode preparation. A native rewrite would have to port that, not only the screens.
It is desktop-first: 175 responsive (`sm/md/lg/xl`) class uses, 11 touch/pointer mentions, 21 files with keyboard handlers,
0 uses of `env(safe-area-…)`, 31 uses of backdrop blur/blend, a floating glass sidebar.

## 3. Toolchain

```
$ uname -m                      arm64   (Apple Silicon)
$ xcodebuild -version           Xcode 27.2, Build version 27B52
$ xcrun --sdk iphoneos --show-sdk-version        27.2
$ xcrun --sdk iphonesimulator --show-sdk-version 27.2
$ xcodebuild -showsdks          iOS 27.2 (iphoneos27.2), Simulator - iOS 27.2 (iphonesimulator27.2)
$ xcrun simctl list runtimes    == Runtimes ==   (empty)
$ xcrun simctl list devices     == Devices ==    (empty);  simctl list devicetypes: 45 iPhone/iPad types
$ go version                    go1.27.1 darwin/arm64      (go.mod: go 1.26.0)
$ go env GOPATH                 /Users/kevinmallari/go
$ which gomobile gobind         not found           (~/go/bin has air, go-outline, gocode-gomod, goimports, gopls, jet, wails3)
$ wails3 version                v3.0.0-beta.28      (go.mod: github.com/wailsapp/wails/v3 v3.0.0-beta.28)
```

**There is no simulator runtime or device installed**, so no iPhone/iPad simulator can boot. Installing one is
a multi-GB download (`xcodebuild -downloadPlatform iOS`, or Xcode › Settings › Components) that I did not
trigger because it changes the user's machine globally. Needed before Phase 2 can run anything.
gomobile was installed for the probe only: `GOBIN=<scratchpad>/gobin go install golang.org/x/mobile/cmd/{gomobile,gobind}@latest`
(`golang.org/x/mobile v0.0.0-20261011034528-197770444867`); nothing on PATH or in `~/go/bin` changed.

## 4. Feasibility probe (throwaway; removed)

Setup: a `git worktree` of `HEAD` in the scratchpad (so `main` was never touched), two tiny packages inside the
module, `go get golang.org/x/mobile/bind` (in the worktree's `go.mod` only), then `gomobile bind`. The worktree was
removed afterwards (`git worktree remove --force`, `git worktree prune`); `git status` on `main` is clean.

| Probe package | Imports | Command | Result | Size |
|---|---|---|---|---|
| `probe/pure` (`Version()`, `Fetch(url)`) | `internal/addons`, `internal/nuvio` | `gomobile bind -target iossimulator` (31 s) | **success** | 30 MB xcframework; framework binary 31.3 MB fat (x86_64+arm64), 15.9 MB arm64 slice |
| same | same | `gomobile bind -target ios` | **success** | 45 MB xcframework (device arm64 slice 15.8 MB + simulator slice) |
| `probe/store` (`Open(path)`) | `internal/store` (so Wails, ~245 deps) | `-target iossimulator` | **success** | 38 MB xcframework; 20.1 MB arm64 slice. Contains Wails' UIKit/WKWebView code (3,162 "wailsapp/wails" strings; none in `pure`) |
| `probe/acct` | `internal/account` | `-target iossimulator` | **fail**: `native_darwin.go:129:22: error: use of undeclared identifier 'code'` (16 errors, `SecCodeRef` etc.): the macOS-only keychain file is compiled on iOS | – |
| `probe/heavy` | `internal/plugins`, `internal/torrent` (`-tags nosqlite`) | `-target iossimulator` | success (compiles; plugins cannot work at run time) | 130 MB xcframework, 69 MB arm64: what the excluded packages would cost |

What this says:

- The module's pure packages bind with no changes. gomobile generated an Objective-C/Swift API for the trivial
  exported functions.
- `store` binds because Wails ships iOS support, but that links Wails' app code and its ObjC into the
  framework. Whether its `init()`s are harmless inside someone else's app is **unverified** (nothing was run:
  no simulator runtime). The cleaner route is the tag split in §6.5.
- `account` (and so `tracking`) break only on the `secrets` darwin file. `player`, `watching` break on the player.
- Excluding torrent + plugins saves ~49 MB in the arm64 slice.
- Not tested: running the framework, bitcode/App Store thinning, the final app size after dead-stripping.

## 5. Wails on iOS: current state

**The user is not right: Wails v3 has an iOS target, though it is experimental.**

Evidence from `go.mod` and the module cache (`github.com/wailsapp/wails/v3@v3.0.0-beta.28`):

- `IOS.md` begins "Wails v3 apps run on iOS as native UIKit applications: a `WKWebView` renders the
  frontend, assets are served **in-process** over a custom `wails://` URL scheme, and the standard Wails runtime
  works unchanged: bindings, events, dialogs and clipboard."
- ~40 iOS files in `pkg/application` (`application_ios.m`, `webview_window_ios.m`, `mobile_features_ios.*`,
  `dialogs_ios.go`, `clipboard_ios.go`, …), `internal/assetserver/*_ios.go`, `internal/commands/ios_xcode_gen.go`,
  build assets `internal/commands/build_assets/ios/{Taskfile.yml,main.m,main_ios.go,…}`, template
  `internal/templates/ios`, `examples/ios-poc`, and an `IOS` object in `@wailsio/runtime`. A matching `ANDROID.md` exists.
- Status table in `IOS.md`: WKWebView + asset serving ✅, service bindings ✅, events ✅, message dialogs ✅,
  open-file dialogs ✅ (imported copies), **save dialogs ❌**, clipboard ✅, screens ✅, lifecycle events ✅,
  haptics/device info/native tab bar ✅, system events ✅, native mobile features (share, biometrics, **Keychain
  `SecureSet/Get/Delete`**, geolocation, keep-awake, orientation …) ✅, **multiple windows ⚠️ only the first**,
  simulator builds ✅, device builds ✅ (manual or generated-Xcode signing), **App Store pipeline ⚠️ "use the generated Xcode project"**.
- Build: `go build -buildmode=c-archive` with `-tags ios` + an overlay, linked by a generated UIKit bootstrap
  (`main.m` runs the Go runtime on a background queue and `UIApplicationMain` on the main thread).
- Compile evidence here: with cgo on, `store`, `syncer`, `backend`, `markers`, `updates` compile for `GOOS=ios`
  (Wails' iOS files are chosen); with `CGO_ENABLED=0` they fail with `undefined: iosApp`
  (`events_common_ios.go`), i.e. the iOS files are real and need cgo.

Online (WebSearch, standard mode, 2026-11-12; results were mostly docs-preview mirrors, so treat details as
**not fully verified**): the official mobile guide says "mobile support in Wails v3 is currently EXPERIMENTAL" and the
API/build process may change before the final release; v3 is in beta and mobile is outside the desktop beta
compatibility promise. Sources:
[wails.io mobile guide](https://wails.io/docs/guides/mobile),
[docs-preview iOS guide](https://docs-preview.wails.io/guides/mobile/ios/),
[docs-preview changelog](https://docs-preview.wails.io/changelog/),
[docs-preview status](https://docs-preview.wails.io/status/),
[v3 beta announcement](https://docs-preview.wails.io/blog/wails-v3-beta/). I did not find a stable-release date. The local
`beta.28` module is the stronger source for what the code does.

**Would it beat a custom bridge?** It removes the bridge work: bindings, events, the asset scheme, Keychain
and URL opening already exist, the frontend runs unchanged, and Peli is already on this exact runtime. It
does not remove the real work: the player, the Wails/`secrets`/`player` seams in §1, and a touch UI.
Against it: it is beta and explicitly unstable; Wails owns `UIApplicationMain`/the app delegate and a single window, so
PiP, AirPlay routing, background audio, scene lifecycle (iPad multitasking) and the AVPlayer/mpv view stacked behind the
webview mean writing Objective-C inside a framework you do not control; the App Store archive path is "use the
generated project". See §6.4: a plausible fast path for a proof of concept, a risky path for a shipped app.

## 6. Architecture recommendation

### 6.0 Verdict on the expected architecture

**Confirmed, with three amendments.**

1. *Replace `@wailsio/runtime`, not each `@bindings/*` module.* The generated bindings are thin wrappers around
   `$Call.ByID`. A Vite alias that points `@wailsio/runtime` at an iOS shim (`Call`, `CancellablePromise`, `Events`,
   `Browser`, `Window`, `System`) keeps all 16 binding modules, their models and every call site byte-for-byte
   identical, and a `wails3 generate bindings -names` run gives stable string method names for the shim.
2. *The iOS core entry should not import Wails.* Split the four Wails glue files with a build tag (§6.5) rather than
   linking Wails' UIKit code into the framework.
3. *Do a short Wails-iOS spike before locking in* (see §7, decision 1). It could replace the bridge if the
   user accepts beta risk.

### 6.1 gomobile type limits and the Go side

gomobile bind supports only ints/floats/bool/string/`[]byte`, `error`, exported structs/interfaces made of those, and
callbacks via interfaces. No maps, no slices other than `[]byte`, no generics, no `context.Context`, at most
one result plus `error`. Per-method exports of the 138 bound methods would not generate. Use one generic
entry plus callbacks:

```go
package mobilecore            // gomobile bind ./mobile/core  → Core.xcframework
type Core struct{ … }
func (c *Core) Call(callID int64, method, argsJSON string) (string, error) // "store.Profiles", "[1,2]"
func (c *Core) Cancel(callID int64)
func (c *Core) Subscribe(h EventHandler)                                    // OnEvent(name, json string)
type EventHandler interface{ OnEvent(name, payload string) }
type Platform interface{                                                    // implemented in Swift
  KeychainGet(key string) ([]byte, error); KeychainSet(key string, v []byte) error; KeychainDelete(key string) error
  PlayerCall(method, argsJSON string) (string, error)                       // iOS player engine
  DataDir() string; OpenURL(url string)
}
func (c *Core) PlayerEvent(name, json string)                               // Swift → Go (state, time, ended, report)
```

Dispatch: a registry `"store.Profiles" → reflect method` over the same service structs, JSON-decoding arguments by
parameter type, injecting `context.Context` for cancellable calls, and encoding errors with each service's existing
`MarshalError` (typed codes such as `kids_profile`, `unreachable`, `expired` must keep their shape because the
frontend branches on them). Reflection is simplest; a generator over the `go/types` of the same service list (as
`wails3 generate bindings` does) is the stricter alternative. The method list is the same one the frontend imports.

### 6.2 Transport and events

- **JS → Swift → Go:** `WKScriptMessageHandlerWithReply` (iOS 14+) — `await webkit.messageHandlers.peli.postMessage({id, method, args})`
  returns a Promise that Swift fulfils from `Core.Call` on a background queue. A `cancel` message maps to
  `Core.Cancel` (needed for `streams.Resolve`, plugin and addon fetches, which use `CancellablePromise`).
- **Assets:** `WKURLSchemeHandler` for `peli://app/…` serving the built `frontend/dist` from the bundle. Needed
  because ES modules and Web Workers (the ranking worker) do not load reliably over `file://`.
- **Fetch/CORS:** keep the existing fallback to `Addons.Fetch`; optionally make the shim route any `fetch` that throws to Go.
  Images stay direct.
- **Go → JS:** `Core` calls `EventHandler.OnEvent`, Swift does `webView.callAsyncJavaScript("window.__peliEmit(name, payload)")` on
  the main actor, and the shim's `Events.On` registers listeners. `player:time` is ≤ 4 Hz (fine); batch if needed.
- **Payload size:** 1,400-stream lists never cross the bridge (the addon client runs in JS, ranking in a Worker).
  Store calls are small. Measure a full `Library()` and `Collections()` early.

### 6.3 Platform seams

| Seam | Desktop today | iOS |
|---|---|---|
| Player | libmpv through cgo under a transparent webview (`host_darwin.m`), 33 `Service` methods, state and time events, `ReportTo` every 10 s and on pause/seek/end | Swift engine (AVPlayer and/or libmpv/VLCKit) in a UIView **behind** the transparent WKWebView, same layering idea as desktop. Go keeps the portable `State`/`LoadOptions`/track/caption rules and receives state/time/reports from Swift. Requires extracting an `Engine` interface and moving `Report`/`Watching` out of `player` (so `watching`, `tracking` compile) |
| Keychain | `go-keyring` / `security` / `native_darwin.go` | `backend` implemented in Swift via the `Platform` callback (`SecItem`, `kSecAttrAccessibleAfterFirstUnlock`) |
| Store path | `xdg.DataHome`/Peli or `$PELI_DATA_DIR` | App container `Application Support/Peli`, passed in; consider excluding from iCloud backup for the cache only |
| HTTP/CORS | webview fetch → Go fallback | unchanged |
| Lifecycle | window focus → pull, push, import (`main.go`) | `scenePhase` active → `Pull`/`Push`/`ImportSoon`; to background → `Pusher.FlushProgress` inside `beginBackgroundTask`. Go goroutines and sockets are suspended in the background; push loops and the Nuvio connection monitor must tolerate resume |
| Media controls | `SetNowPlaying`, MPRIS/SMTC/MPNowPlaying | `MPNowPlayingInfoCenter`/`MPRemoteCommandCenter`, AirPlay, audio session `.playback` |
| Auth UX | QR sign-in, system browser for OAuth | `Browser.OpenURL` → `SFSafariViewController`/`ASWebAuthenticationSession`; **AniList's redirect is `http://127.0.0.1:47613/anilist`** (a local listener) — works only while the app is foregrounded, else use a custom scheme redirect (needs a new AniList app id) |
| Kids/PIN | `guardKids`, parent approval | unchanged Go; optional biometrics |
| Platform flags | `System.IsMac/Windows/Linux` | `isIOS`, `isTouch`; hide Torrent, Plugins, Party, Updates, Picture/Sound/Quality settings |

### 6.4 Alternatives

Reuse numbers are estimates from the line counts above. Effort is solo, in weeks, rough.

| | Reuse | Effort | Touch / iPad feel | App Store risk | Maintenance |
|---|---|---|---|---|---|
| **(a) gomobile Go core + SwiftUI shell + WKWebView with bridge** (recommended) | Go core ≈ 16.7 k lines (needs the §1 seams); frontend ≈ 85–90 % (logic 100 %, but every screen needs touch, safe-area and layout work) | 12–18 wk incl. player | Good once the UI is adapted; web-in-webview scrolling and 60 fps rows are the risk | Low–medium (webview app; no JIT; user-added addons raise the usual content-policy review risk — **unverified**, check before submission) | Bridge stays small (one `Call` + events); two UI targets share React |
| **(b) Native SwiftUI screens over the Go core** | Go core only; the ranking engine, addon client, resolve and title rules (~4 k+ lines TS) would be reimplemented or run in JavaScriptCore | 25–40 wk | Best | Lowest | Highest: two implementations of the product logic |
| **(c) Wails v3 iOS target** | Frontend 100 % unchanged runtime; Go glue same as desktop; still needs the player + seams + touch UI | PoC 1–2 wk; shipped app 10–16 wk | As (a), but Swift-level features (PiP, scenes) are harder | Medium: beta framework, single window, App Store via generated Xcode project | Tied to Wails mobile releases (experimental) |
| **(d) Capacitor/Tauri-mobile-style wrapper** | Frontend yes, Go core no (Capacitor: JS/Swift plugins; Tauri: Rust) | Large rewrite of the Go core | Same as (a) | Same as (a) | New stack for the same job as (a); not credible here |

### 6.5 Build-tag plan and proof

Prefer package boundaries over tags: a new `mobile/core` (or `cmd/mobilecore`) package imports only the 16 core
packages, never `torrent`, `plugins`, `party`, `updates`, `firstmouse`, the mpv half of `player`. Tags are only for
code inside core packages that touches Wails or macOS:

- `internal/{store,account,syncer,tracking}/wails.go` (the `ServiceStartup` methods, `application.RegisterEvent`):
  `//go:build !mobile && !ios`. Add a `mobile` tag (not only `ios`, because tests on macOS cannot set `GOOS=ios`).
- `internal/secrets/native_darwin.go`, `firstmouse_darwin.go`, `player/*_darwin.go`, `updates/installed_darwin.go`:
  `darwin && !ios`; `native_other.go` becomes `!darwin || ios`, plus a Swift-callback `backend` for iOS.
- `player`: extract `internal/playback` (types, rules, `Report`) used by `watching`/`tracking`; mpv engine stays in `player`.

Proof, as a test in the mobile core package (works with plain `go test -tags mobile`):

```go
out, _ := exec.Command("go","list","-deps","-tags","mobile","./mobile/core").Output()
for _, bad := range []string{"wailsapp/wails","anacrolix","dop251/goja","internal/torrent","internal/plugins",
                             "internal/party","internal/updates","internal/player","pion/"} {
    if strings.Contains(string(out), bad) { t.Errorf("mobile core imports %s", bad) }
}
```

Also: `GOOS=ios CGO_ENABLED=1 go vet -tags mobile ./mobile/core` in CI, and `go tool nm`/`strings` on the built
xcframework to check no `wailsapp` and no `anacrolix` symbols (the probe showed this works: 0 `wailsapp/wails`
strings in the `pure` framework, 3,162 in the `store` one).

### 6.6 Playback reality check

Corpus: 7,390 unique streams (by `infoHash`+`fileIdx`) from `spikes/stream-ranking/fixtures/*/*.json`, recorded from
Torrentio, Comet, Peerflix and TorrentsDB on 2026-10 (no live calls). Container comes from the
`behaviorHints.filename` extension; codecs from regexes on the stream's name/title text (indicative only: 57 % of titles
do not mention audio at all, and "other/?" video is 29 %). "Debrid-cached" is the subset whose name carries a `+]`/`⚡` cache marker (2,709).

| Measure | All (7,390) | Debrid-cached (2,709) |
|---|---|---|
| `.mkv` | 77 % | 81 % |
| `.mp4` / `.m4v` / `.mov` | 9 % | 8 % |
| `.avi` | 6 % | 4 % |
| container unknown | 7 % | 6 % |
| HEVC (x265) | 38 % | 41 % |
| H.264 | 29 % | 27 % |
| AV1 | 4 % | 4 % |
| HEVC in MKV | 34 % | 37 % |
| mentions DTS/DTS-HD/TrueHD | 8 % | 7 % |
| mentions E-AC-3/DD+ | 15 % | 19 % |
| AAC | 9 % | 9 % |
| MP4 and H.264/HEVC (the AVPlayer-friendly case) | **6.8 %** | **6.1 %** |

AVPlayer does not play Matroska. Evidence: no Matroska/`mkv` type in the iOS 27.2 SDK's AVFoundation headers;
this is background knowledge for earlier iOS versions too. A device test on iOS 27 is **unverified** (no runtime). Also
AVPlayer cannot play DTS/TrueHD, AVI/XviD, ASS/PGS subtitles in these containers, or most AV1 on hardware older than the
A17 Pro. So roughly **90 % of what debrid addons return will not play in AVPlayer**.

Options and costs:

1. **libmpv for iOS (recommended path).** Reuses `build/libmpv` (mpv 0.41, `-Dgpl=false`, FFmpeg 9.0.2, libplacebo,
   libass, dav1d all static; today OpenGL-only, macOS-only; `build.sh` has no iOS target). Needs an iOS arm64 + simulator
   cross build, a render path (OpenGL ES is deprecated but works; Metal via libplacebo/MoltenVK is heavier), VideoToolbox
   hwdec (supported by mpv on iOS), and a **dynamic** framework so the LGPL build stays relinkable. Plays everything in the
   corpus, keeps libass styling and the existing Go-side track rules. Effort ~3–5 wk including the Swift host view. Risks: Metal/GL
   layering under a transparent WKWebView, PiP (needs a sample-buffer path; limited), app size (+25–30 MB).
   Third-party iOS mpv builds exist (MPVKit); licensing and flags **unverified**, ADR-0003 says only our own build ships.
2. **VLCKit** (LGPL-2.1). Plays MKV/HEVC/DTS/ASS out of the box; ~1–2 wk to integrate; separate state model, no `LoadOptions`
   parity (the Go track/caption rules would need mapping), ~80–100 MB (**unverified**), another upstream to track.
3. **Ranking that prefers AVPlayer-compatible files on iOS.** Cheap (a ranking weight like `-30,000` cap penalty in
   `stream-preferences`), but with 6–9 % MP4 it would often leave an empty or poor list; useful as a "fast start"
   bonus only, and AVPlayer is still the best choice for PiP/AirPlay/Now Playing on the files it can play.
4. **Server-side remux/transcode.** Needs infrastructure the product does not have, and Peli holds no debrid keys
   (ADR-0038). Not recommended; some debrid services offer an HLS "stream" endpoint (**unverified**), which would reopen ADR-0038.

Recommendation: spike #1 first (2–3 days: mpv iOS build + render a fixture in a UIView over a blank WKWebView on a
device), with #2 as the fallback and #3 as a tie-breaker weight, not the plan.

## 7. Decisions for the user

1. **Shell: custom Swift bridge or Wails' iOS target?** (a) bridge: more code, full native control (PiP, scenes, audio
   session), no beta dependency. (c) Wails iOS: least bridge code, runs the same `main.go` runtime, but experimental, one
   window, Wails owns the app delegate. *Recommendation:* (a), after a 1–2 day Wails iOS spike on a copy to see whether the
   desktop runtime plus a Swift-added player view is good enough. Both need the same Phase 1 work, so Phase 1 is not blocked by this.
2. **Player engine on iOS:** libmpv (parity, ~90 % of streams play, +25–30 MB, 3–5 wk), VLCKit (faster to start,
   different model, bigger), or AVPlayer-only (HEVC/AV1/MKV mostly unplayable). *Recommendation:* libmpv, behind a
   spike gate, AVPlayer for MP4 only if PiP becomes a requirement.
3. **Distribution:** a paid Apple Developer account is needed for device installs beyond 7-day free profiles, TestFlight
   and the App Store. Options: personal/TestFlight only, or App Store. A client for user-supplied addons has content-policy
   review risk (**unverified**). *Recommendation:* TestFlight first.
4. **AniList redirect:** keep `http://127.0.0.1:47613/anilist` (works only in the foreground) or register a new AniList app
   with a custom-scheme redirect. *Recommendation:* a new app id and `ASWebAuthenticationSession`.
5. **iPhone, iPad or both in v1.** The React UI is desktop-first; iPad (sidebar kept) is cheaper than iPhone
   (tab bar, single column, player gestures). *Recommendation:* iPad first, iPhone in the same phase only if the responsive pass is cheap.
6. **Minimum iOS version.** `WKScriptMessageHandlerWithReply` needs 14; Wails' template uses 15; SDK is 27.2.
   *Recommendation:* iOS 17 (a recent baseline is cheap here; avoid old WebKit quirks).
7. **Install the iOS simulator runtime** (multi-GB, global to the Mac). Required to verify anything beyond compilation.
8. **Mac Catalyst / "Designed for iPad on Apple silicon Macs":** ignore (the macOS app already exists).

## 8. Phase sketch

**Phase 1: shared core.** Make the 16 core packages build with `GOOS=ios` and a `mobile` tag: split the Wails glue out of
`store`/`account`/`syncer`/`tracking`, make `secrets` selectable (`darwin && !ios`, a `backend` callback), extract `Report`/`Watching`/rules
from `player` into a package `watching` and `tracking` import, add `ios` to `account/qr.go`, add the `go list -deps` guard test and CI
`GOOS=ios go vet`. Desktop must keep passing (`go test ./internal/...`; note that on `main` `store`, `plugins` tests had
pre-existing failures per memory). Risks: the `player` split is the largest refactor (4.8 k lines) and touches the desktop path;
test failures that predate it must be separated from new ones.

**Phase 2: shell + bridge.** Xcode project (SwiftUI app, `WKWebView`, `WKURLSchemeHandler`, reply message handler),
`mobile/core` (`Call`, `Cancel`, `Subscribe`, `Platform`, registry/dispatcher), the `@wailsio/runtime` shim
and a Vite `ios` build mode, `generate bindings -names`. Risks: Wails runtime semantics the frontend relies on (promise
cancellation, error shape, event payloads), Web Worker and module loading from the custom scheme, ATS, main-thread blocking by long Go calls,
and no simulator runtime installed yet.

**Phase 3: auth.** Sign-in, QR sign-in, profile picker, PINs, kids; Keychain backend; session refresh when the app
is resumed. Risks: keychain accessibility class and reinstall behaviour, 2,560-byte item limit assumptions, token refresh racing app
suspension, `Browser.OpenURL`, parent-approval window semantics when the app is killed.

**Phase 4: browsing.** Home, Browse, Search, Title over the addon client and manager; touch layouts (sidebar → iPad
sidebar/tab bar), safe areas, no hover, virtualized rows at 60 fps in WKWebView, memory (the repo has WebKit leak/cache notes in
`virtualized-rows`). Risks: the UI is desktop-first (175 breakpoint classes, 31 backdrop-blur uses, 21 keyboard files), glass effects
cost on older iPads, `http://` addons under ATS, TMDB key entry on a phone.

**Phase 5: playback.** Debrid request → ranking → resolve → player (engine per decision 2), resume, tracks, subtitles,
next episode, Now Playing/AirPlay, touch controls and gestures. Risks: the MKV/HEVC/DTS reality (§6.6), mpv build and layering, resolve links
that expire mid-play and `reloadExpired`, thermal/battery, background audio, expired-link behaviour after suspend, `usePreparedNext` assumptions.

**Phase 6: scrobbling.** `watching` progress and the SIMKL/AniList outbox with offline/reconnect on iOS lifecycle: flush on
background inside `beginBackgroundTask`, retry on foreground (replaces window focus), network monitor. Risks: app suspension drops
sockets mid-push, the Nuvio connection monitor and outbox timers while suspended, AniList OAuth redirect (decision 4), the 90 % watched rule when the OS kills the app.

**Phase 7: verify and hand off.** Real-device matrix (iPhone/iPad, iOS minimum + latest), the `go list -deps` proof,
binary size, TestFlight, notices/licences for the iOS binary (mpv/FFmpeg LGPL relinking), docs. Risks: no Developer ID/Apple
Developer account yet (macOS notarization is also pending per memory), App Review, store-listing content policy.

## Unverified (could not or did not check)

- Anything at runtime: no simulator runtime is installed and no device is attached. The bound frameworks were never loaded.
- That Wails' `init()`/ObjC code is harmless when the store framework is linked into a Swift app.
- That AVPlayer on iOS 27 still cannot play Matroska (SDK headers only).
- `adrg/xdg` paths on iOS; Web Workers and ES modules over a custom scheme; ATS on webview `fetch`.
- MPVKit's flags/licence, VLCKit's current size and licence terms, mpv on iOS with Metal, PiP with mpv.
- App Store review outcome for an addon client; whether any debrid service offers an HLS transcode endpoint.
- Wails upstream status beyond the local `beta.28` source and the docs-preview mirrors returned by search (the search snippets
  quote different beta numbers than `go.mod`).
- Codec mix is regex-based and from recorded Torrentio/Comet/Peerflix/TorrentsDB answers, not the user's current addons.
