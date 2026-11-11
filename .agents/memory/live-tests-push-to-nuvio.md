---
name: live-tests-push-to-nuvio
description: "A built app run on a copy of the real store is still signed in to the user's real Nuvio account and pushes whatever it writes"
metadata:
  type: feedback
---

Running `bin/peli` with `PELI_DATA_DIR` holding a copy of the real `peli.db` still uses the real keychain session, so every watched mark, progress entry or import it writes is pushed to the user's real Nuvio account. On 2026-10-31 the #71 live test pushed 103 imported marks and two test plays that way, and they had to be deleted from Nuvio again.

**Why:** the copy keeps the Nuvio-linked profiles, and the session lives in the keychain, not the store.

**How to apply:** before a live run that writes marks or progress, use a Guest/local profile or a store with no Nuvio-linked profiles (or sign the copy out), or plan the undo: compare `WatchedDelta`/`ProgressDelta` since the real store's cursors with what the run added, and delete exactly those. Deleting from the real account needs the user's go-ahead. Related: [[nuvio-live-account]], [[tracking-integrations]].
