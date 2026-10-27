---
status: accepted
date: 2026-10-21
---

# The push loop: the store wakes it, the outbox is the queue, the server's thresholds set the pace

Changes made on this device go to Nuvio without anyone asking (#30). `internal/syncer/pusher.go` owns the *when*; `backend.Backend.Push` (ADR-0015) owns the wire; the outbox in the store (#14) is the queue and survives a restart.

## When it pushes

- **After a change.** `Store.OnQueued` calls the pusher once a write that queued a push has committed (it compares the outbox's sequence number before and after, so every current and future queueing write is covered, and `ApplyChanges`, acks and cursors are not). No polling. The pusher waits `Debounce` (2 s) after the last change, but never more than `MaxWait` (10 s) after the first, so a burst of edits is one request and a steady stream doesn't starve. That is well inside the epic's 30 s.
- **Progress, at most every 30 s per entry** (`ProgressEvery`). The server ignores an update unless the position moved 15 s or `last_watched` is 30 s newer (a 200, nothing written; M0 gotcha 1), so a player that saves every few seconds gets the first push at the debounce, then one every 30 s with the latest position. The outbox already keeps one push per item, so the held one is always the newest. Deletes are never held.
- **On pause, stop, seek and exit: `Service.Flush`**, which the player calls through `flushPushes()` in `lib/sync.ts`. It sends everything now, ignoring the 30 s hold, the watched grace and the backoff. At exit, `ServiceShutdown` flushes with a 5 s limit (services shut down in reverse order, so the store is still open).
- **On launch and window focus** (`Background`, ignoring the backoff but not more than once per 10 s), so what failed while offline goes out when the user comes back. Detecting the network coming back is #31's.
- **At sign-out**, `account.FlushOnSignOut`: the account service flushes (10 s limit) before it ends the session, while the session still works. Offline, the push fails at once and the sign-out goes ahead; what couldn't be sent is lost, which the confirm dialog says. This closes #22's hand-off.

## Failures

A failed push stays in the outbox with `Attempts` and `LastError` (`Store.FailPush`). The loop backs off from 5 s, doubling to 5 min, with up to a fifth shaved off so devices that failed together don't retry together. This sits on top of the client's own full-jitter retry on a 429 (#20), which is what handles a 429 without `Retry-After`. Any success resets it. Timers respect the backoff; launch, focus and an explicit flush don't. A signed-out session is retried the same way: the account service tells the user (ADR-0009), and signing in again lets the next push through. The outbox is bbolt, so a push survives a crash or restart, and the first flush after launch sends it.

## Watched items: the server makes them, so we wait

The server creates a watched item itself when progress reaches 90 % of an item of a minute or more (gotcha 2), with its own 60 s update interval. If the player also marks the item watched, the push would repeat it. So a watched upsert for an item whose finished progress is going out, or went out in the last `WatchedGrace` (75 s), is held back. After the grace the pusher pulls (`refresh` = `Puller.Pull`, itself throttled) and `ApplyChanges` settles the push: **a pulled watched upsert drops a queued watched upsert of the same item**, since both only say "watched" and the backend has it. If the pull didn't find it (the server's throttle dropped the progress, say), the push goes out. A watched mark with no finished progress behind it goes at once, and a flush doesn't wait. A queued watched *delete* is never settled by a pulled upsert: it is the user's later decision.

## Never home layout or collections

`store.Surface` has four values, all with a call in the sync module; `backend.Syncs` says which, `Nuvio.Push` refuses anything else before it contacts the backend, and the pusher drops such a push with a warning rather than retry it forever. `TestNoLayoutOrCollectionCalls` fails if `internal/nuvio` names either in a string. #35 may sync them to a non-official backend; it needs its own surface and its own `Backend`. (Since #35: they have their own surfaces and are pushed through `backend.Nuvio` to a custom server only, see [ADR-0022](0022-home-layout-and-collections.md).)

## What we give up

- **A push inside the server's thresholds is still dropped.** A pause 5 s after the last push, a few seconds further on, sends a position the server ignores, and we ack it (ADR-0015). Local is ahead of the server by under 15 s until the next push, and the pull's latest-`lastWatched`-wins rule (ADR-0016) keeps our position. Keeping such a push queued until it is worth sending would mean a queue that never empties and a sign-out that can't finish.
- **The 30 s timer lives in memory.** After a restart the first progress push goes at once, which is the right default when we don't know what the server has.
- **Only the profile with queued pushes is sent, but all profiles are checked** on each flush (a few bbolt reads), because the user may have switched profile inside the debounce.
- **Not shown against live.** Like the pull, this is tested against `nuviotest`; library and watched push shapes are from the schema (ADR-0015). #33's contract tests and the per-release live check are where that gets covered.

## Revisit if

Nuvio adds a batch or push endpoint, the player (M3) wants a different progress cadence, or the server's thresholds change.
