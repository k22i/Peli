---
status: accepted
date: 2026-11-05
---

# Remembered stream source: a fingerprint per profile and show, matched by the ranking engine, replaced by whatever plays

#58 (F19) asks Sinag to remember the source a viewer chose for a show and pick its best match for the next episode, falling back to the ranked top pick, with an easy override in the picker and the player's switcher.

## What is kept

A `ChosenSource` per profile and show in the Go store (`profiles/<id>/sources/<content id>`): the source's key (an addon's URL, or `plugin:<id>`), the file's resolution and release group as the ranking parser read them, and when it was chosen. It is local to the device. Nuvio has nowhere to sync it, and the addon URLs it names belong to this device's install. Deleting the profile deletes it. Films keep none: they have no next episode.

It isn't kept as a file or an infohash. The next episode is another file, often from another torrent, so only the fingerprint carries over. The same group from the same addon usually means the same encode, audio tracks and subtitles.

## How it is matched

The fingerprint goes into the ranking `Prefs` (`remembered`). It changes no score. It only changes which candidate the engine calls the top pick (`lib/ranking/remembered.ts`), so the picker, the player's stream switcher and the next-episode card (`usePreparedNext`) all agree, as ADR-0039 asked of #68:

- The quality must match. Then the group (case-insensitive) counts 2 and the addon counts 1, where any copy of the file from that addon counts. A candidate needs the group or the addon as well as the quality. The closest match wins, and the higher-ranked one wins a tie.
- It is never a likely fake or a CAM, never a stream above the device's resolution cap (#98, ADR-0048), and never a debrid stream that needs a download when the ranked best plays at once. With no match the ranked top pick stays, which is the ticket's fallback.
- Pinning (#52) still holds. Once the user moves into the list, a closer match that arrives later doesn't take over.

The picker and switcher show "Top pick · Same source as last time" when the top pick matches. The next-episode card waits for the store to answer before it takes its pick, so it never resolves the unremembered best first.

## The override is the pick

Whatever plays becomes the show's source: a pick from the picker, a switch in the player (#68), or the next episode playing. Picking any other stream in either list is the override, so there is no separate setting or "forget" control. Saving never fails a play. If the store can't save, the old fingerprint stays.

## Not done

- No "forget" button. If one is wanted, `SetChosenSource(id, contentId, null)` already forgets.
- Not synced. If Nuvio ever has a per-title preference, it would go through the sync module like the other surfaces.
