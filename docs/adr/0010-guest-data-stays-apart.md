---
status: accepted
date: 2026-10-20
---

# The Guest profile stays apart: signing in never merges guest data into the account

Peli works with no account on one local **Guest** profile (#23). Its addons, library, progress and watched items live only in the local store (ADR-0006), and nothing it does reaches Nuvio. **Signing in doesn't merge the Guest into the account.** Nuvio's profiles are added beside it and one becomes current, and the Guest stays on this device as it was. **Signing out** removes only the account's profiles (ADR-0009), so the Guest survives that too.

- **One Guest.** `Profile.Guest` marks it. There is at most one, and it can't be linked to a Nuvio profile. **Continue as guest** (`Store.SwitchToGuest`) finds it or creates it.
- **Its sync backend is local.** `backend.For` returns `backend.Local` for any profile not linked to Nuvio. `Local` pulls nothing and sends nothing, and the store queues no pushes for such a profile. The sync module (#28) adds the Nuvio backend beside it.

## Why

- **Merging addons would wipe the account's.** `sync_push_addons` replaces the whole list (gotcha 2 of the [Nuvio spike](../spikes/nuvio-backend.md#gotchas-for-28)), so pushing the Guest's addons would replace an account's carefully ordered list. Merging them first means deciding order and duplicates for someone else's setup.
- **Progress and watched items conflict.** The same title can have progress in both, and Nuvio silently drops a progress push unless it moved ≥ 15 s or is ≥ 30 s newer (gotcha 1). A merge would be lossy in ways the user can't see.
- **A guest isn't always the account's owner.** On a shared computer, a visitor's watching shouldn't land in whoever signs in next, and on Nuvio that would reach every device the account uses.
- **Nothing is lost by waiting.** The Guest stays on the device, so its data is still there to switch back to with the picker (#24), or to copy later if users ask.

## What we give up

- **Someone who starts as a guest and then signs in doesn't take their library with them.** They see the account's library, and the Guest's stays on its own profile. The welcome and sign-in screens say so.
- **The Guest uses a profile slot in the picker** for as long as it exists. Deleting it is the picker's job (#24).

## Revisit if

Users ask to bring guest data into their account. Then add an opt-in **Copy to this profile** for library and watched items (not addons, and progress only where the account has none), run once and pushed as ordinary changes. It would be its own ticket, not a silent merge on sign-in.
