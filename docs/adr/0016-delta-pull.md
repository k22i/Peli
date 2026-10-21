---
status: accepted
date: 2026-10-21
---

# The delta pull: Go decides when, the store decides who wins

The library, progress and watched feeds of the profile in use are pulled from Nuvio by delta cursor and merged into the local store (#29). `internal/syncer` owns the *when*; `Store.ApplyChanges` (ADR-0015) owns the merge; `backend.Backend.Pull` owns the wire.

## When it pulls

- **On launch**, from `ApplicationStarted`, in a goroutine: the window and the cached UI never wait for it.
- **On window focus**, from `WindowFocus` in `main.go`. This is the acceptance criterion: progress changed on the phone appears on the desktop when the user comes back to the window.
- **Every five minutes** while the app is open (`PollEvery`), because the feeds have no push channel (the M0 spike found no realtime channel, so the cursors are all there is).
- **When the profile in use changes**, from the frontend (`useSyncProfile`): after sign-in, from the picker, from the profile menu. Go can't see these without the account and store services knowing about the syncer, and one call from the root gate does.

Pulls are **throttled per profile** to one every 30 s (`MinGap`), so a window that is focused over and over, or a profile switched back and forth, makes no request. Only one pull runs at a time. Only the **profile in use** is pulled: six linked profiles would be 18 calls a focus, and switching to another one pulls it from its stored cursor. A profile with no Nuvio link, the Guest first among them, makes no request at all (#23, the test in `internal/account/guest_test.go` still holds).

## What a pull does

For each of library, progress and watched: read the cursor from the store (`Store.Cursor`, #14), `Backend.Pull` from it (a first pull has none and reads from event 0, page after page), `ApplyChanges`, then `SetCursor`. The cursor moves only after the merge has committed, and merging is idempotent, so a pull that dies half way is repeated without harm. A pull with nothing new keeps its cursor.

- **Failures.** An error that would be the same for every feed (signed out, unreachable, rate limited, down: `backend.Down`) stops the pull and leaves the cursors. Any other error is kept, the other feeds are still pulled, and the errors come back together. Being offline or signed out is not logged (`backend.Offline`): the account service already tells the user when a session has ended (ADR-0009). A pull that finds its profile gone (signed out, deleted) is not an error.
- **A bad row.** If the store refuses a change as invalid (a row without a content ID), the rest of the page is applied one change at a time and that one is dropped with a warning, so one row can't hold a feed's cursor back for good.
- **Telling the frontend.** After a pull that wrote something, Go emits `sync:pulled` with the profile and the surfaces changed (`Pulled`). `useSyncEvents` invalidates the TanStack Query caches under the keys of those surfaces (`surfaceQueryKeys` in `lib/sync.ts`: `library`, `progress` and `continue-watching`, `watched`). A screen that shows synced data keys its query under one of those prefixes. A pull that changed nothing emits nothing, which also means the echo of our own pushes doesn't refresh anything.

## Conflicts

`ApplyChanges` resolves them, per surface:

| Surface | Rule |
|---|---|
| **Progress** | **Latest `lastWatched` wins**, whichever device wrote it. A pulled entry older than ours is skipped; a pulled delete is skipped if our entry was watched after the row it names (a delete carries the row as it was). Equal times take the backend's copy. |
| **Library, watched** | The backend's copy wins. Neither has a timestamp that says which device acted last, and both are add-or-remove. |
| **Any item with a push still queued** | Skipped: the user changed it here since, and the push will overwrite the backend's copy. |

Progress needs a rule of its own because it is the one edited from several devices at once, and because the backend drops a progress push that comes too soon after the last (a 200, nothing written; M0 gotcha). We ack that push, so without the rule the next pull would bring back the older position and undo what the user just watched. With it, our newer position stays and goes out with the next push.

## Not here

- **Addons** have no delta feed and belong to #32.
- **Profiles** are still pulled by the account service at sign-in (ADR-0015). Pulling them at launch needs `LinkNuvioProfiles` split so it doesn't reset the current profile; no ticket owns it yet.
- **The push loop and the sign-out flush** are #30 (ADR-0017). One rule crosses over: a pulled watched upsert drops a queued watched upsert of the same item. Watched items can appear after #30's pushes (the server's 90 % rule); the pull picks them up like any other.

## What we give up

- **A profile that isn't in use goes stale** until it is switched to; then it catches up from its cursor in one pull.
- **A pull holds a whole feed in memory** (ADR-0015); the first pull of a very large account is the case that could hurt.
- **Library and watched are last-pull-wins**, so two devices that remove and re-add the same title between pulls settle on whichever the server saw last.

## Revisit if

Nuvio adds a push channel (then the poll and the focus pull go away), or a feed needs a timestamp rule too.
