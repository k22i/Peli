---
status: accepted
date: 2026-10-29
---

# The addon manager: one Go edit per action, shown at once, reconfigure in place

#38 builds the addon manager on `/addons`: install by address, configure, reorder, turn on or off, and remove with undo. It builds on the addon list sync (#32, ADR-0019) and the protocol client (#37, ADR-0023). This ADR records the choices that weren't settled by those.

## Every action is one edit in Go

The page never writes back a list it read. Each action is one bound call that changes the stored list in a single transaction: `InstallAddon`, `InsertAddon`, `ReconfigureAddon`, `RemoveAddon`, `MoveAddon` and `EnableAddon` on `account.Service`. A pull that lands between reading the list and the edit can't be undone by it, and the push loop merges the new list with other devices' changes (ADR-0019). Every method goes through `editAddons`, so a kids profile's addons, or any while one is in use, need the parent PIN (ADR-0014).

Two edits are new:

- **`InsertAddon(addon, at)`** puts a removed addon back where it was. It is the undo in the "Removed" toast. `InstallAddon` is `InsertAddon` at the end.
- **`ReconfigureAddon(url, addon)`** swaps an addon for the address its configure page gave, in the same place, keeping whether it was on. In the same transaction it rewrites a kids profile's allow-list (`KidsScope.Addons` and `Catalogs`) to the new URL, so a reconfigured addon stays allowed, and it drops any stale entry for the new URL first, so a reconfigure can't allow an addon the parent hadn't.

## Shown before Go answers

`useEditAddons` applies each edit to the cached list in `onMutate` (`applyAddonEdit`, which mirrors the store's rules), rolls it back if Go refuses, and rereads the list afterwards. Edits share a mutation scope per profile, so they run in order. The order catalogs and streams are asked in comes from this list (`routing.ts` keeps the order given), so a move takes effect on the next request at once. It doesn't wait for the save.

## Install and configure

- **Addresses.** `addonLink` accepts a manifest URL, an addon's base URL, `stremio://` links and links that name the addon in an `addon` parameter, as Stremio's web install links do. Only http and https are fetched. Pasting a `stremio://` link works; Peli doesn't register itself as the OS handler for `stremio://`, which would take the scheme from Stremio if it's installed.
- **Validation.** Nothing is saved until the manifest reads, fresh from the addon and not retried. An address that isn't an addon, one already installed, or one that `configurationRequired` is refused with the reason. An addon that needs configuring gets a button to its configure page instead.
- **Configure.** The configure page is Stremio's convention, `{base}/configure`, opened in the user's browser. The user pastes the new address back. It must be the same addon (the same manifest `id`, when the old manifest loaded). The menu offers Configure when the manifest says `configurable` or `configurationRequired`, or when it failed to load, since a new address may be the fix.

## Reorder

Dragging uses native HTML5 drag and drop on the rows, started only from the grip so text and controls behave normally. The Wails runtime's document listeners handle file drags only and let these through. The grip is a button: arrow keys move by one, Home and End to the ends, and a polite live region says where it went. The row's menu has the same moves. No drag library was added.

## Privacy

An addon's address can hold the user's settings and debrid key in its path. The manager shows only the host. The full address appears only in the field the user pastes into.

## What we give up

- **Undo is a new edit, not a rollback.** If another device changed the list in between, the addon goes back at its old index in the new list.
- **Approval can run out mid-session.** The parent PIN approval lasts two minutes. An edit refused for it asks for the PIN again and retries.
- **Reconfiguring is copy and paste.** Stremio's configure pages hand back a `stremio://` link the OS opens, which Peli doesn't receive without a scheme handler.

## Revisit if

Peli registers a URL scheme (its own, or `stremio://`) so configure pages can hand the address back directly; or Nuvio adds per-addon settings outside the URL.
