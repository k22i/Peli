---
status: accepted
date: 2026-10-20
---

# Profile changes go to Nuvio first, one profile at a time, and are refused offline rather than queued

Peli adds, edits and deletes profiles itself (#95), from a **Manage profiles** mode in the picker. **A Nuvio profile changes in Nuvio first, and on this device only once Nuvio has it.** Offline or signed out, the change fails with a message and nothing is queued. The Guest is local-only, so it changes on this device alone.

- **Edits use `sync_patch_profile`.** It's a sparse patch: only the name, colour or avatar that changed is sent, and the rest of the profile and the other profiles stay as they are. Avatars come only from `get_avatar_catalog`, checked in Go before sending.
- **Adding uses `sync_push_profiles` with the whole list.** Go pulls the profiles fresh and pushes every one, with every field, plus the new one at the lowest index free both in Nuvio and on this device, with `p_client_max_profiles: 6`. With six profiles it refuses and says so.
- **Deleting uses `sync_delete_profile_data`**, after a confirmation that says the profile's library, progress, addons and settings go from every device. Peli never deletes the primary profile (index 1) or the account's last one, though the server would allow both.
- **The Guest** can be renamed, and removed as before. It never gets Nuvio's avatars or colours.

## Why

- **Live and self-host may disagree on `sync_push_profiles`.** On self-host it only upserts. Nuvio's public API doc says it replaces the list and deletes the profiles left out, defaulting to slots 1–4. Deleting a profile also deletes all of its data on every device. A full, fresh list is safe under both behaviours, and a push also resets the fields it isn't sent (docs/spikes/nuvio-backend.md). So pushes are kept to adding, and edits use the patch, which can't touch another profile.
- **Nuvio's own account dashboard does the same:** the patch for edits, the full list for adding, `sync_delete_profile_data` for deleting, and it refuses to delete the primary, whose addons and plugins other profiles can share.
- **Queueing profile changes would need conflict rules** that the sync module (#28) hasn't settled yet. A rename that lands an hour later on another device, or a delete queued against a profile that changed meanwhile, is worse than a clear "try again online". Profile changes are rare, so the cost of asking for a connection is small.
- **Checking avatars in Go matters.** An unknown avatar ID is refused with `42501`, the code Peli reads as "signed out", which would refresh the session and then send the user to sign in.

## What we give up

- **No profile changes offline,** even a rename. #28 may revisit this once it has an outbox for other writes.
- **A race when adding.** A profile added on another device between Peli's pull and push, about a second apart, would be deleted if live replaces the list.
- **Hosted-only fields aren't pushed.** Live profiles have `profile_background_id` and `profile_background_url`. A push doesn't send them, and neither does Nuvio's dashboard. Whether live resets them on a push is untested: they were null on the test account. Only adding a profile pushes.
- **What's on the device is what Nuvio last said.** A profile deleted on another device stays here until #28 pulls profiles again. Editing it says it's gone, and its index isn't reused for a new profile until then.
- **PIN-locked profiles can be edited and deleted without the PIN** until #25 puts the PIN prompt in front of them too.

## Revisit if

Nuvio confirms `sync_push_profiles` upserts on live too (then a push with only the new profile is enough), or #28's outbox can carry profile changes with conflict rules.
