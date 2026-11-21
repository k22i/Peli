# Downloads, part 1: the store (#85, ADR-0064)

## What changed

- **`internal/store/downloads.go` (new).** The `Download`, `DownloadRequest`, `DownloadSubtitle` and `DownloadSegment` types as ADR-0064's Store section defines them (same names, same JSON tags, comments in the file's style), `DownloadStates`, `ErrDownloadNotFound`, and the eight methods: `Downloads`, `ProfileDownloads`, `Download`, `PutDownload`, `UpdateDownload`, `SetDownloadProgress`, `DeleteDownload`, `DownloadedBytes`.
  - One top-level bucket, `bucketDownloads = []byte("downloads")`, keyed by the download id, values JSON through `put`/`decodeOnto` like every other record. It is not under `profiles` and nothing here queues a push: downloads never sync to Nuvio (ADR-0038).
  - Lists are sorted by `CreatedAt`, then `ID` (`slices.SortFunc`), so the queue's order is the same on every read whatever order records were written in.
  - Nil `Subtitles`, `Segments` and `Request.Headers` come back empty (`[]…`/`map[string]string{}`), on reads and on writes.
  - `PutDownload` refuses (`ErrInvalidItem`) a record with no ID, no profile, no video id, no `request.url`, or a state outside `DownloadStates`.
  - `UpdateDownload` decodes, runs `fn`, validates the result exactly as `PutDownload`, and writes it; an error from `fn`, a validation refusal or an id change rolls the transaction back, leaving the record as it was. A missing id is `ErrDownloadNotFound`.
  - `SetDownloadProgress` sets `Bytes`, `Total` and `UpdatedAt` (unix ms) through `UpdateDownload`, so a missing id is `ErrDownloadNotFound` too.
  - `DownloadedBytes` sums `Bytes` over every record, whatever its state (queued, downloading, paused, waiting, failed, done).
  - No imports from `internal/streams` or `internal/markers`: the subtitle and segment types are store-local copies on purpose.
- **`internal/store/migrate.go`.** One migration appended (`CreateBucketIfNotExists(bucketDownloads)`). No shipped migration was touched.
- **`internal/store/store.go`.** The package comment's layout gains `downloads <id> → Download (device-level, #85)`, and the package doc lists the device's downloads among what the store holds.
- **`internal/store/settings.go`.** `DeviceSettings` gains `DownloadsDir`, `DownloadsCapGB` and `DownloadsWiFiOnly` (ADR JSON tags, comments in file style); `DownloadCaps = []int{10, 25, 50, 100, 250, 500}`; `DefaultDeviceSettings` sets `DownloadsCapGB: 50` and `DownloadsWiFiOnly: true` (`DownloadsDir` stays `""`, the default folder); `SaveDeviceSettings` — the one place device settings are validated — refuses a `DownloadsDir` that is neither `""` nor `filepath.IsAbs`, and a `DownloadsCapGB` outside `DownloadCaps` (`ErrInvalidSettings`). `Store.DeviceSettings` already decodes the saved record over `DefaultDeviceSettings()`, so a record written before these fields reads with the defaults; that is checked by a new test.
- **Tests.** `internal/store/downloads_test.go` (new): put/get/list per profile, ordering (out-of-order writes, and two records sharing `CreatedAt`), nil lists back empty, update (and each refusal leaving the record alone), progress, delete (missing id fine), `DownloadedBytes` over every state and after a delete, validation refusals, and a reopen that keeps the queue. `settings_test.go`: `laptop` and the default comparison carry the new fields, plus `TestDeviceSettingsDownloads` (defaults, each refusal, every cap accepted and saved) and `TestDeviceSettingsDownloadsDecodeOverDefaults` (a record without the fields reads with 50 GB, Wi-Fi only, the default folder). `migrate_test.go`: `TestMigrateAddsDownloads` (no bucket before schema 5, a download there and after another open, schema at `len(migrations)`), `fixtureData` now saves the device's settings whole, and `TestFixtures` expectations are per-fixture (see below).

## Files touched

| File | |
|---|---|
| `internal/store/downloads.go` | new: types, states, error, eight methods |
| `internal/store/downloads_test.go` | new: the store's downloads tests |
| `internal/store/migrate.go` | migration appended |
| `internal/store/store.go` | layout comment, package doc |
| `internal/store/settings.go` | three device fields, `DownloadCaps`, defaults, validation |
| `internal/store/settings_test.go` | new fields in `laptop` and the default comparison, two new tests |
| `internal/store/migrate_test.go` | schema-5 test, whole-settings fixture, per-fixture expectations |

Nothing outside `internal/store` and `reports/` changed.

## Deviations from ADR-0064

1. **The migration is number 5, not the ADR's "migration 8".** This branch's `main` (`18809fd`, the ADR commit) ships four migrations, so the next index is 5; the coordinator confirmed that the ADR's 8 counted helper functions. The migration itself is the ADR's: one `CreateBucketIfNotExists` for the top-level bucket. Nothing else about it differs.
2. **`UpdateDownload` refuses an id change** (`ErrInvalidItem`). The ADR says read-modify-write and doesn't say what a rewritten ID means; writing under the new key would leave the old record behind and make `Download(id)` miss it, so the write keeps the key it read.
3. **`Request.Headers` reads back as an empty map, not a nil slice.** The ADR says nil slices decode as empty; headers are a map, and the task's list of nil fields names it, so it is filled the same way.
4. **`SetDownloadProgress` goes through `UpdateDownload`**, so it decodes and re-validates rather than firing a bare `put`. The record was validated when written, so this can't refuse in practice; it keeps one write path and keeps `ErrDownloadNotFound` in one place. It is the only write the downloader makes every couple of seconds, and one decode of a small JSON record is cheap.
5. **Reads are nil-safe about a missing bucket and `PutDownload` creates it if needed** (`CreateBucketIfNotExists`). Migration 5 always creates it; this only keeps a `Store` built without migrations from panicking.
6. **No Wails `Service` methods were added.** ADR-0064 puts the downloads surface (`Add`, `Playable`, `Pause`, …) in `internal/downloads` (parts 2 and 3), which is outside this task's files. See the open questions.

## The schema-5 fixture is missing

`TestFixtures` requires a fixture for the newest schema, `internal/store/testdata/schema-5.db`, and the only way to write one is `go test ./internal/store -run TestFixtures -update`, which this task forbids (the coordinator runs all tests after merging). Until that command runs once, `TestFixtures` fails with "no fixture for schema 5".

**Agreed with the coordinator:** they run that one command after merging and commit `internal/store/testdata/schema-5.db` themselves.

To make that one run the whole job, `fixtureData` now saves the device's settings whole (`DefaultDeviceSettings` with hardware decoding off and diagnostics on) instead of a partial literal, and `TestFixtures`'s expectations moved into the per-fixture switch: the default (which the new fixture and every later one take) is those whole settings, `schema-4.db` keeps the partial-record expectations it needs — including `skipTimesOnline: false`, which that file really recorded — with the downloads fields at their defaults, and `schema-1..3` are as they were. Profile settings likewise default to `japanese` whole, with the older fixtures' overrides in the switch.

## Other Go files that build a `store.DeviceSettings{…}` literal (not edited)

`grep -rn "DeviceSettings{" --include=*.go .` outside `internal/store` finds three, all partial literals read field by field, none compared with a whole `DeviceSettings`, so none needs the new fields:

| File | Literal | Why it's fine |
|---|---|---|
| `internal/markers/markers_test.go:34` | `store.DeviceSettings{SkipTimesOnline: s.online}` | fake for the settings interface; only `SkipTimesOnline` is read |
| `internal/torrent/torrent_test.go:31` | `store.DeviceSettings{TorrentStreaming: true, TorrentCacheGB: 5}` (and `store.DefaultDeviceSettings()` at :193) | only those two fields are read |
| `internal/player/decoding_test.go:33-34` | `store.DeviceSettings{HardwareDecoding: true}` / `{false}` | only `HardwareDecoding` is read |

## Open questions

- **`@bindings/store`'s `Download` model.** ADR-0064's frontend section says `Download` comes from `@bindings/store`, but nothing on `store.Service` returns one: the model only reaches the webview if some `Service` method references it. If part 3's `internal/downloads` service returns `store.Download` values, Wails will generate the model under `@bindings/downloads` instead. Either a `store.Service` method (e.g. `Downloads(profileID)`) is added in a later part, or part 4 imports the model from `@bindings/downloads`. Not added here, because the ADR gives the store no downloads surface beyond `*Store`.
- **Schema-5 fixture.** The coordinator runs `go test ./internal/store -run TestFixtures -update` once after merging and commits the fixture (see above), so the worktree carries no `schema-5.db`.
- **Cap units.** `DownloadedBytes` is bytes and `DownloadsCapGB` is GB; the 10^9 vs 2^30 choice belongs to the engine (part 2), which compares the two.
