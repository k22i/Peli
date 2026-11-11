---
status: accepted
date: 2026-10-27
---

# Addon list sync: pull the whole list, push a three-way merge, share the primary's list

A profile's installed addons sync with Nuvio, so an addon installed on the desktop shows in Nuvio on the phone and TV, and the other way round (#32, F5). The wire calls were in place from #28 (ADR-0015); this ADR covers when the list moves, how a push avoids undoing another device's change, which Nuvio profile a list belongs to, and what happens to an addon that won't load.

## Pull: the whole list, every pull

Addons have no delta feed (gotcha 3), so the pull (ADR-0016) reads `GET /rest/v1/addons?profile_id=eq.N&order=sort_order.asc` every time it reads the other feeds: at launch, on focus, every 5 min and on a profile change, for the profile in use. It is one small request. `Store.ApplyChanges` writes the list if it differs, and the frontend hears `sync:pulled` with `addons` and refreshes the `["addons", id]` queries. A profile that never had a list counts as having an empty one, so an empty account's first pull reports no change. A pull doesn't touch a list with a push queued, as for every surface.

## Push: merged with what the server has now

`sync_push_addons` replaces the whole list, and an empty array deletes every addon on the profile. Pushing a list that is out of date would undo what another device changed since this device last pulled: the phone installs B, the desktop (which hasn't pulled) installs C, and B is gone everywhere. So:

- **The push carries its base.** `store.Push.Base` is the list as the backend last had it: the list before the first edit that hasn't been sent, kept across later edits until the push is acked. An edit that changes nothing queues nothing.
- **`backend.Nuvio` merges before it sends.** It reads the server's list, applies what changed from base to local onto it, and pushes the result (`mergeAddons` in `internal/backend/addons.go`). Removed here: removed. Added here: added before the addon after it here, or last, as an install does (updated if another device added it too). Turned on or off, or renamed, here: so there too, unless another device removed it, which wins. Reordered here: our order, with what only the server has after it; otherwise the server's order stands. With nothing changed elsewhere the result is exactly the local list.
- **The local list catches up on the next pull.** The push is acked, so the next pull applies the merged list. Until then, a further edit still merges correctly: its base is the list it was edited from.

A push queued before this change has no base and is sent as it is, as before.

## Edits are single operations in Go

The addon manager (#38) calls `Account.InstallAddon`, `RemoveAddon`, `MoveAddon` and `EnableAddon` (through `useEditAddons` in `lib/addons.ts`). Each is one edit of the stored list inside one transaction, so the frontend never writes back a list it read earlier, which could undo a pull that landed in between. They are on the account service because addons of a kids profile, or any while one is in use, change only with the parent PIN (ADR-0014). `Store.SetAddons` is no longer bound to the frontend.

## `uses_primary_addons`: the primary's list

The server doesn't redirect. A profile created with `uses_primary_addons = true` gets no addon rows (its default-addons trigger only fills a profile that doesn't share), and `GET /rest/v1/addons?profile_id=eq.3` returns nothing. Nuvio's apps read profile 1's list for it. Peli does the same: `store.Profile.UsesPrimaryAddons` comes from `sync_pull_profiles` on sign-in and refresh, and `backend.Nuvio` pulls and pushes index 1 for such a profile. Its local copy is profile 1's list, so a kids allow-list (ADR-0014) works on it unchanged. An edit made from a sharing profile changes profile 1's addons on every device, which is what sharing means in Nuvio; the `/addons` page says so. Confirmed from the self-host SQL (`handle_new_profile_default_addons`, `sync_push_addons`), not on live.

## An addon that won't load stays

Nothing in sync looks at manifests: a list entry is kept whatever its manifest does, since dropping it locally would delete it everywhere at the next push. The `/addons` page lists the synced addons in order and fetches each manifest (`manifestQuery`, 15 s timeout, one retry); one that fails shows why ("The addon answered 404.") and that it stays installed. Nuvio stores some addons by their base URL, so `manifestUrl` adds `/manifest.json` when it is missing. The typed addon client (#37) replaces this small fetch, and the manager (#38) adds the controls.

## What we give up

- **An extra read per addons push.** Pushes are rare (a user editing the list), so this is cheap.
- **Concurrent edits of the same addon pick ours.** If two devices turn the same addon on and off, the last push wins; there's no timestamp to do better.
- **A read-modify-write race remains.** Another device pushing between our read and our push is lost. The window is one round trip.
- **Not shown against live.** Writing addons on the user's live account would replace their real list; the fake in `nuviotest` and the self-host schema stand in, as for ADR-0015. #33's contract tests cover it.

## Revisit if

Nuvio adds an addons feed, per-row addon calls or a compare-and-swap on the list, or starts redirecting sharing profiles server-side.
