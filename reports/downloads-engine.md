# Downloads part 2: engine and Wails service (#85)

Not compiled or run (the task forbids it): the coordinator runs `go vet`, gofmt and the tests after merging.

## What changed

- `internal/downloads` (new): `service.go` (types, `Config`, `NewService`, bound methods, `MarshalError`, `ErrUnsupported`, startup/shutdown), `queue.go` (loop, recovery, sweeps, iOS background/active/expiring, gate, cap/space check), `http.go` (the runner: resolve, Range GET, part file, expiry, size check, subtitles, segments), `platform_desktop.go` (`!ios`), `freespace_unix.go`, `freespace_windows.go`, tests (`rig_test.go`, `downloads_test.go`).
- `main.go`: `p.streams` hoisted, `p.downloads` built after `p.skipTimes`, registered right after `add(x.torrent)` with `downloads.MarshalError`.
- `ios_boundary_test.go`: `internal/downloads` added to the required-on-iOS list (only that).
- `internal/streams` untouched: error codes are read with `errors.Is` on its exported sentinels (`codeOf` in service.go), no string parsing.

## For part 3

- **Platform injection: `Config.Platform` (nil = `newPlatform()`).** Part 3 defines `newPlatform() Platform` in `platform_ios.go`; nothing else to wire.
- `ErrUnsupported = errors.New("downloads: not supported on this platform")` is in service.go, mapped to code `unsupported`.
- Shared helpers part 3 may use: `freeSpace(dir)` and `diskFull(err)` (`!windows` build), `fail(code)`/`*Error`.
- iOS logic is in shared code: `background()` (asks `Platform.Background(s.expiring)` only when a job runs), `expiring()` (stops picking, checkpoints the job to `waiting`/`suspended`, calls `end()`), `active()` (ends background time, requeues `suspended` jobs). While in the background after a job finishes, the next queued job keeps running until none is left, then `end()` is called.
- Wi-Fi gate checks `runtime.GOOS == "ios"` (field `isIOS`, overridable in tests).

## Deviations and choices

- Recovery also requeues `waiting` jobs whose reason is `wifi`/`offline` (the ADR lists only `downloading` and `waiting`+`suspended`). Nothing else would wake a waiting job after a relaunch; the gate waits again if it still applies.
- `Resolve` errors `unreachable`/`timeout` put the job in `waiting`/`offline` with backoff rather than failing it; the other streams codes (`expired`, `busy`, `caching`, `denied`, `failed`, `not_video`, `invalid`) fail the job with that code.
- 429 and 5xx from the CDN also back off (`waiting`/`offline`); any other unexpected status fails with `failed`.
- The record's `File` carries `.part` while the job isn't done (ADR store comment) and is renamed on completion.
- A new download records `Root = DeviceSettings.DownloadsDir` (`""` = default `Config.Root`).
- `Config` gained `Platform`; `MarshalError` adds a `message` field (`"downloads: <code>"`), no error text.
- Wails' folder-dialog cancel returns an empty path, which `ChooseFolder` reports as `""`.
- Progress/store write intervals, backoff, stall watchdog (60 s without bytes counts as a network error) are fields on `Service`, overridden by tests.

## Open questions

- Resolving on retry after a network error reuses the resolved CDN link; only an expiry re-resolves.
- Subtitle and marker fetches repeat on each resume for items still missing (cheap, bounded).
