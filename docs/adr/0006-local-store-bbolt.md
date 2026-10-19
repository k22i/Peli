---
status: accepted
date: 2026-10-19
---

# Local storage is a bbolt key-value file, not SQLite

**bbolt.** Sinag keeps its local data in one [bbolt](https://github.com/etcd-io/bbolt) file, `Sinag/sinag.db` in the OS app-data directory (#14). That data is profiles and, per profile, the library, watch progress, watched items and addons, Nuvio sync cursors and pending pushes, plus a shared cache. bbolt is a pure-Go, transactional B+tree store, so cgo stays limited to libmpv and the webview. The M0 gate (#8) had planned SQLite through `modernc.org/sqlite`.

## Why

- **The data is small and is always read by profile.** A heavy user has a few thousand library items and progress entries and up to ~50,000 watched episodes. A typical one has hundreds. Every read is "all of this profile's X" or "this title's X", and those are one bucket or one prefix scan. Continue Watching sorts a few thousand entries in Go. Measured with heavy-user data, opening the file and loading Home (Continue Watching plus the library) takes **~17 ms** on an M1 Pro. On CI runners it takes 13 ms on macOS, 21 ms on Linux and 43 ms on Windows (2–5 vCPU). One title's watched episodes take 0.07 ms. Home's budget is ~1 s ([baselines](../spikes/baselines.md#cold-start)).
- **It's smaller.** bbolt adds **~0.4 MB** to the binary (+399 KB on macOS arm64, +417 KB on Windows amd64, with `-s -w`). A pure-Go SQLite adds several MB, inside a 60 MB installer budget ([ADR-0005](0005-nfr-targets-after-m0.md)).
- **Isolation comes from the layout.** Each profile is its own bucket, and every read and write goes through it, so one profile can't see another's data. Deleting the bucket deletes everything the profile had.
- **One writer, one process.** bbolt allows one read-write transaction at a time and locks the file to one process. Sinag is a single desktop process, and a second instance gets a clear "in use" error.

## What we give up

- **No SQL, so we write the queries.** Sorting, filtering and anything shaped like a join (the calendar, #48) are Go code over decoded records. If a list gets big enough to matter, its index is a second bucket that we keep up to date in the same transaction.
- **No `ALTER TABLE`.** Records are JSON. Migrations are numbered Go functions that rewrite records, each in its own transaction with the version bump. A file from a newer build is refused rather than misread. Each shipped schema keeps a fixture (`internal/store/testdata/schema-<n>.db`) that later builds must still open.
- **You can't open the file in a DB browser.** Debugging means a small Go program or the `bbolt` CLI.
- **The file doesn't shrink on its own.** bbolt reuses freed pages but doesn't return them to the OS. At these sizes it's a few MB. If the cache makes it grow, compacting on startup (`bbolt compact`) is the fix.

## Revisit if

We need ad-hoc queries over large data, such as full-text search across a big library or analytics over history. If so, move to SQLite behind the same `internal/store` API. The frontend and the sync module only see that API.
