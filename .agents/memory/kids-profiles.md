---
name: kids-profiles
description: "How Sinag's kids profiles work (#26): local flag, addon allow-list, parent PIN = the profile's own PIN; where later screens must call"
metadata:
  type: project
---

Kids profiles (#26, ADR-0014). Nuvio has no kids flag, so `store.Profile.Kids` and the `store.KidsScope` allow-list (addon URLs, optional catalogs) are local to the device. `UpdateProfile` and `LinkNuvioProfiles` keep the flag, since Nuvio's copy never has it.

**Why:** the ticket says "restrict to catalogs/addons chosen for that profile; leaving needs the parent PIN". Home, browse and search (#42–#44) and the addon manager (#38) didn't exist, so the ticket built the rule they call, not a filtered screen.

**How to apply:**
- Home, browse, search and title pages must ask `Store.VisibleAddons(profileID)` / `CatalogVisible`, never `Addons`, or a kids profile sees everything. Streams and subtitles aren't limited.
- The parent PIN is the kids profile's own Nuvio PIN. `account.ApproveParent` (2-minute window, cleared on any switch) is needed to leave it, or to change any profile or the account while it's in use. `UnlockProfile` only lets it be entered. Any new Go method that changes profiles, addons or the account should call `Service.guardKids`; the addon edits (`account/addons.go`, #32) already do, so #38 only needs to call them.
- The frontend asks for PINs with `usePinSteps` / `pinSteps` (`components/account/pin-dialog.tsx`); `parentSteps(current)` for actions that aren't about one profile.
- Related: [[nuvio-profile-pins]].
