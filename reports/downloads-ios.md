# Downloads, part 3: iOS native (#85)

## What changed

- `internal/downloads/platform_ios.go`, `platform_ios.m`, `platform_ios.h` (all `//go:build ios`): `newPlatform() Platform` returning the iOS platform.
  - `FreeSpace`: `NSURLVolumeAvailableCapacityForImportantUsageKey` (falls back to `NSFileSystemFreeSize`), asked of the nearest existing ancestor when the folder isn't there yet. This is the whole low-storage duty: the "important usage" figure is what iOS would free for the app. Part 2 checks it before each job and handles ENOSPC.
  - `Prepare`: MkdirAll 0o700, then `NSURLIsExcludedFromBackupKey` on the root, on every call.
  - `Network` / `WatchNetwork`: one `nw_path_monitor_t`, started lazily on a serial queue, latest value cached atomically in Go. `Network()` waits up to 300 ms for the first reading (online, not expensive until then). Watchers run on a Go goroutine via `safego`, only when the value changed. `iosshell.Cellular()` (SCNetworkReachability) was not reused: it is a one-shot read and has no expensive/hotspot flag. `iosshell` is untouched.
  - `Background`: `beginBackgroundTaskWithName:@"Peli downloads"` on the main thread; the expiration handler calls `expiring` (synchronously, so Go flushes first) then ends the task. A 1 s timer calls `expiring` early when `backgroundTimeRemaining` < 5 s. `expiring` runs at most once per call (`sync.Once`); `end` is idempotent. If iOS refuses the task, `end` is a no-op.
  - `WatchLifecycle`: `UIApplicationDidEnterBackgroundNotification` and `UIApplicationDidBecomeActiveNotification`, as `internal/iosplayer/host_ios.m` does.
  - `ChooseFolder`: `"", ErrUnsupported`.
- Ordering: lifecycle, network and early-expiry callbacks go through one event goroutine (a channel), so they arrive in order: background → (expiring, at most once) → active. The OS expiration handler's call is synchronous and deliberately not queued.
- `ios_boundary_test.go`: `TestIOSDownloadsCgoFiles` pins CgoFiles/MFiles/HFiles only (not GoFiles), as agreed with the coordinator.
- `ios/README.md`: a "Downloads" section with the rules and the device checklist.

No Info.plist or `build/ios` change is needed. `main_ios.go` is untouched.

## Assumptions and deviations

- `ErrUnsupported` and `Platform`/`Network` come from part 2's shared code (coordinator-confirmed: `var ErrUnsupported = errors.New("downloads: not supported on this platform")`). Not defined here.
- `newPlatform()` is a function. I return a package singleton, since the C callbacks are global.
- No Go test: the platform needs the iOS SDK (cgo). The manual checks are in the README checklist.
- Nothing was compiled or run (per the rules). gofmt alignment and cgo type conversions (`C.ulong` map keys, `C.PELI_DL_*` macros) are unchecked.

## Open questions

- Whether `Network()`'s 300 ms wait on first use is acceptable when called from the Wails service's startup.
