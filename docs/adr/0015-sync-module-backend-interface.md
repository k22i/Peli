---
status: accepted
date: 2026-10-21
---

# The sync module: two interfaces, one Nuvio client, and an import boundary

All backend calls live in `internal/nuvio` (the wire) and `internal/backend` (the sync module on top of it) (#28). A profile syncs through a `backend.Backend`: `Nuvio` for a profile linked to a Nuvio profile, `Local` for one that isn't, such as the Guest. A custom server is the same `Nuvio` at another URL.

- **`Backend` is the data: `Pull` and `Push`.** `Pull(profile, surface, cursor)` returns every change since the cursor, across as many pages as it takes, and the cursor to pass next. `Push(profile, pushes)` takes the store's outbox and returns the pushes the backend now has, for `store.AckPush`. Surfaces are library, progress, watched and addons. `Local` pulls nothing and acks every push.
- **`Remote` is the account side**: sign-in, QR login, refresh, profiles, PINs and avatars. `internal/account` takes a `backend.Remote` instead of a `*nuvio.Client`, and keeps its types (`nuvio.Session`, `nuvio.Profile`) because only Nuvio has accounts. `Sessions` (`account.Session.Do`) lends the sync module a live session and refreshes once on `ErrSignedOut`, so the refresh stays in one place (ADR-0009).
- **Import boundary, as a test.** `internal/nuvio/boundary_test.go` fails if a package other than `main`, `internal/account` or `internal/backend` imports `internal/nuvio`, if any other Go file names a Supabase path or host, or if `go.mod`, `frontend/package.json` or the frontend's sources mention Supabase.
- **Applying a pull is the store's job.** `Store.ApplyChanges` writes a feed to a profile in one transaction and queues no push. It is idempotent: a change equal to what is stored does nothing, which is how the echo of our own writes (the feed has no origin) is ignored. A change to an item with a push still queued is skipped, so the echo of an earlier write can't undo a newer local one.
- **The client is polite on its own.** A token bucket keeps it to 20 requests a second (burst 20) against the shared 900, on top of the full-jitter backoff on 429 from #20. Every write sends `p_origin_client_id`, a random per-process `sinag-…` ID.

## How the server's behaviours are handled

| Behaviour (spike gotchas) | Here |
|---|---|
| Progress pushes dropped inside 15 s / 30 s, with a 200 | `Push` acks progress once it is sent. The next push carries newer data; the player (#30) decides when to push. |
| Addons pushes replace the list | The outbox keeps one addons push, always the whole list; `Push` sends the newest. `PushAddons` copies its input and numbers `sort_order` itself. |
| One global event sequence, gaps normal | Cursors are opaque `int64`s in the store. A pull with no events keeps its cursor. |
| Our writes echo back | `ApplyChanges` is idempotent and skips queued items. |
| `42501` / `28000` / `PGRST301` | `ErrSignedOut` (from #20). `Push` stops at any backend-wide error (signed out, unreachable, 429, 5xx) and keeps going past a batch the server alone refused. |
| Overloaded RPCs | Every push and delete sends every argument. |

## Decisions the ticket left open

- **Addons have no delta feed**, so `Pull` returns the whole list as one change each time, from `GET /rest/v1/addons`, and the cursor doesn't move. Whether a secondary profile with `uses_primary_addons` should read profile 1's list is #32's to settle; Sinag doesn't store that flag yet.
- **Profile settings stay local.** `ProfileSettings` (#17) are not synced; Nuvio's `sync_*_profile_settings_blob` has no `desktop` platform, and the blob is a versioned feature blob whose shape isn't ours. Revisit with the "later" surfaces (settings, plugins, collections).
- **Profiles are still pulled by the account service**, at sign-in. Pulling them at launch needs `LinkNuvioProfiles` split so it doesn't reset the current profile (#24's note); no ticket owns it yet (ADR-0016).
- **The sign-out flush** (#22's hand-off) needs the push loop, so it comes with #30.

## What we give up

- **A pull holds a whole feed in memory.** A first pull of a very large account is tens of thousands of small events. If that hurts, `Pull` can return a page and a "more" flag.
- **Push shapes for library, watched and addons are from the schema, not live.** Progress was exercised on live in M0; the others ran against the self-host schema at commit `30f1568` and the fake in `nuviotest`. #33's contract tests and the per-release live check cover them.
- **A corrupt item blocks its batch.** Items come from our own store, so this is a bug if it happens; the failure is recorded on the pushes and the other batches still go.

## Also fixed

A watched item's push key was its binary bucket key, which JSON turns into U+FFFD from episode 127 on, so such a push could never be acked and was re-sent forever. It is now text (`watchedPushKey`).

## Revisit if

Nuvio adds a push channel (then `Pull` becomes a subscription) or a real batch endpoint.
