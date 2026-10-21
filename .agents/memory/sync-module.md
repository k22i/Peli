---
name: sync-module
description: "How Sinag's sync module (#28) is laid out: Backend/Remote interfaces, ApplyChanges, fake Nuvio sync server, boundary test, what #32 still owns"
metadata:
  type: project
---

The sync module (#28, ADR-0015) is `internal/nuvio` (wire: `sync.go` has the library/progress/watched/addons RPCs, `limiter` in `nuvio.go`) plus `internal/backend` (`Backend` Pull/Push, `Nuvio` and `Local` implementations, `Remote` for account calls, `Sessions` = `account.Session.Do`). `store.ApplyChanges` applies a pulled feed without queuing pushes (idempotent, skips items with a queued push). `nuviotest` has a fake sync backend (global event IDs, progress throttle, 90 % watched, addons replace-all; `Rows`, `SyncedAddons`, `DroppedProgress`).

**Why:** the epic splits work into waves; #28 settles the interface and the primitives so #29 (delta pull loop), #30 (debounced push, sign-out flush), #32 (addon sync, `uses_primary_addons`), #34 (custom URL) can each live in their own file.

**How to apply:**
- New Nuvio calls go in `internal/nuvio`, never elsewhere; `internal/nuvio/boundary_test.go` fails on a stray import or Supabase path.
- Running Go tests here needs `apt-get install libgtk-4-dev libwebkitgtk-6.0-dev pkg-config` (the CI's `LINUX_DEPS`); `main.go` needs `frontend/dist` to build.
- The store's watched push key is text (`watchedPushKey`); the bucket key stays binary.
- Reading the self-host repo's SQL (`NuvioMedia/self-host`, clone to scratchpad) is how push shapes were found; re-implement, copy nothing (GPL-3).
- The delta pull (#29, ADR-0016) is `internal/syncer` (`Puller` plain Go; `Service` is the Wails wrapper). Triggers: launch and window focus from `main.go` via `PullerOf(sync).Background`, a 5-minute poll, and the frontend's `useSyncProfile`; 30 s throttle per profile, profile in use only, library/progress/watched (not addons). Progress conflicts: latest `lastWatched` wins, in `Store.ApplyChanges`. `backend.Down`/`backend.Offline` classify errors, since only account/backend may import `internal/nuvio`.
- Frontend tests need generated bindings: `go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.28` (to a scratch GOBIN), then `PATH=… pnpm run bindings` in `frontend/`. `go test ./...` needs `mkdir frontend/dist` too (git-ignored).
- The push loop (#30, ADR-0017) is `internal/syncer/pusher.go`. `Store.OnQueued` (outbox sequence compared around every `update`) wakes it; `store.NotifyQueued(db, fn)` hands it to `store.Service` before startup. Debounce 2 s / max 10 s, progress per entry every 30 s, backoff 5 s→5 min, `Service.Flush` for pause/stop/exit, `account.FlushOnSignOut`. Watched upserts wait 75 s behind a finished progress push, and a pulled watched upsert drops a queued one (`applyChange`). Tests drive `p.flush(ctx, auto|kick|force)` with a fake `p.now`; `TestPushFollowsChanges` uses the real timer. Frontend: `flushPushes()` in `lib/sync.ts` is for the M3 player.
- `apt-get update` first, then the `LINUX_DEPS` install; `frontend/dist` needs a file (`touch frontend/dist/.keep`) for `go vet .`.
