---
name: crash-diagnostics
description: "#127 iOS crash diagnostics: internal/diagnostics (ring, crash files, loop guard, Diagnostics bound service), internal/iosshell (WebKit-kill handler hooked from main.m), safego, router ErrorScreen, route restore, pelidev crash tests in Settings"
metadata:
  type: project
---

Built 2026-11-17 for #127 (epic #126). #128 and #141 build on it.

**Layout:**
- `internal/diagnostics`: `Install()` sets slog's default to stderr + a 2,000-line `Ring`. `Start` moves `logs/last.txt` to `previous.txt`, rotates `crash/<launch>.txt` (empty ones = clean runs, removed; keep 5) and calls `debug.SetCrashOutput`. `Flush` writes the ring out. The bound `Service` has `Report`, `SetRoute`, `ShareLogs`, `LastCrash`, `Info` (`dev`, `logs`) and `DevCrash`. Platform calls are plain functions so Wails doesn't bind them: `Terminated` (loop guard: twice in 30 s → Home, three in 2 min → error page; returns the URL with `?peli-recovered=reload|home`), `NavigationFailed`, `MemoryWarning` (emits `diagnostics:memory-warning`), `Breadcrumbs`/`SetActive` (a `memory:` line every 30 s). The desktop has no ring and no crash files (`Desktop` platform reveals the folder), so its logging is as before.
- `internal/iosshell` (cgo + `shell_ios.m`): `peliCrashRecovery()` adds `webViewWebContentProcessDidTerminate:` and the `…withError:` failure methods to `WailsViewController` and observes memory warnings. It is called from `build/ios/main.m` before `UIApplicationMain`, because WebKit caches which delegate methods exist when the delegate is set. It loads the URL Go returns, not `[webView reload]`, so the page sees the marker. `Platform` = share sheet (`UIActivityViewController`, iPad popover centred), `os_proc_available_memory`, `phys_footprint`, device line. The boundary test pins its files (`TestIOSShellFiles`).
- `main_ios.go`: Install/Start before `newPeli`, `p.diag`, `recoverWebview`, `Logger: slog.Default()`, a `PanicHandler` that logs + flushes (Wails' default is fatal), and flush/SetActive in the lifecycle hooks.
- `internal/safego`: `Go(name, fn)` / `defer Recover(name)`, on the syncer loops, tracking import/outbox, animelist warm, iosplayer events/stats, the image proxy and the dev rig.
- Frontend: `lib/diagnostics.ts` (reportError 20/min, ignores AbortError/CancelledError; `trackRoute` saves `restoreTarget` to sessionStorage `peli.route` + `SetRoute` on iOS; `restoreRoute()` in main.tsx before the router; `trimCaches`). `components/error-screen.tsx` is the root `errorComponent` and `defaultErrorComponent` on every platform. `components/settings/diagnostics-rows.tsx` holds Settings → About → Diagnostics (iOS and `Info().logs`) and, when `Info().dev`, the crash tests. `lib/dev-crash.ts` provides `window.peliDev`. Tests mock `@bindings/diagnostics` in `test/setup.ts`.

**Facts:**
- Wails 3.1.0 recovers a panic in a bound method (`BoundMethod.Call` → a `CallError` the frontend sees as a rejection, plus `PanicHandler`). Panics in Wails' event/callback goroutines go through `handlePanic`, which is fatal unless a `PanicHandler` is set.
- `DevBuild` is set by `dev_ios.go`'s `init`, so the crash tests show in any `pelidev` build, even without `PELI_DEV_DIR`. Device pelidev .ipa: `wails3 task ios:package:ipa IOS_PLATFORM=device IOS_PRODUCTION=false EXTRA_TAGS=pelidev` (production builds ignore `EXTRA_TAGS`).
- The `iosplayer` boundary check in `TestIOSBuildLeavesOutTheDesktopOnlyPieces` already failed on main before #127 (it lists the older file set).

Related: [[ios-port]], [[ios-sidestore]], [[ios-polish-epic]].
