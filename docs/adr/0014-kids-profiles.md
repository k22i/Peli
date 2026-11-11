---
status: accepted
date: 2026-10-21
---

# Kids profiles: a local flag and an allow-list of addons, left with the profile's own PIN

A **kids profile** (#26) is a Nuvio profile the parent marks as one. It shows only the addons the parent chose, and it can only be left, or changed, with its PIN. Nuvio has no kids flag (`sync_pull_profiles` carries a name, an avatar, `uses_primary_*` and the PIN fields), so both the flag and the choice live on this device.

- **`Profile.Kids`** is stored locally. Syncing a profile from Nuvio (`LinkNuvioProfiles`, `UpdateProfile`) keeps it, since Nuvio's copy never has it. A profile needs a Nuvio link and a PIN to be one (`Service.SetKids`), because the PIN is what guards it.
- **`KidsScope`** is an allow-list: addon manifest URLs, and optionally some of an addon's catalogs. What isn't named is hidden, so an addon installed later, or a catalog an addon adds, stays out until the parent picks it. A new kids profile sees nothing. `Store.VisibleAddons` and `CatalogVisible` are the one place Home, browse, search and title pages (#42–#45) ask what a profile may see, so no screen has to remember to filter.
- **The parent PIN is the kids profile's own Nuvio PIN.** Nuvio's PINs are per profile and gate *entering* it. For a kids profile Peli also asks for it to *leave* or change it: `ApproveParent` checks it with `verify_profile_pin` and lasts two minutes or until the next switch. Switching into a kids profile clears the approval, so handing the app over locks it. Unlocking (`UnlockProfile`) is a separate, weaker step: it lets the profile be entered.
- **The rule is in Go.** While a kids profile is in use, switching, signing in or out, and adding, editing, deleting or setting a PIN on any profile need the approval. Changing the kids profile itself needs it from anywhere. `store.Service`'s own shortcuts (`SetCurrentProfile`, `SwitchToGuest`) refuse outright. The frontend only asks for the PINs in the right order (`pinSteps`).

## Why

- **Nuvio can't hold it.** Its API has no place for a kids flag or a per-profile catalog list, so syncing one would mean inventing a side channel on someone else's backend.
- **Allow, don't block.** A block-list fails open: a new addon, or a new catalog in an old one, would reach a child before the parent saw it. Fail closed costs one switch per addon.
- **One PIN, not two.** A separate parent PIN would be a new secret to store, sync and recover. The kids profile's PIN already exists in Nuvio, and the parent chose it.
- **A short window, not a session.** If approval lasted until the next switch, a parent who edits the profile and hands the app back leaves it open. Two minutes is enough to change a few things.

## What we give up

- **The flag is per computer.** A kids profile on one machine is an ordinary profile on another until the parent marks it there. Signing in on a new machine needs the setup again.
- **Leaving needs a connection.** Checking the PIN is `verify_profile_pin`, so a parent offline can't leave a kids profile. The same is true of any PIN-locked profile since #25.
- **A PIN removed elsewhere weakens it.** If the PIN is cleared in Nuvio's own app, the profile keeps its restrictions but leaving it asks for nothing, as `UnlockProfile` does for any profile with no PIN. The parent can turn kids mode off, or set a PIN again.
- **Addon-level only for now.** The model has catalogs, but choosing them needs the addons' manifests (#37), so the editor offers addons. Streams and subtitles aren't limited: they are asked for after a title was chosen from an allowed catalog.

## Revisit if

Nuvio adds a kids or age-rating flag. Then read it on sign-in instead of keeping our own, and keep the allow-list for what the flag can't say.
