---
name: debrid-keys
description: "#54 decision (ADR-0038): Sinag holds no debrid keys — addons do; Settings row points to /addons; when to revisit; #97 needs AD/PM test accounts from the user"
metadata:
  type: project
---

Sinag stores no debrid key (#54, ADR-0038, 2026-10-30). Addons find, mark cached and resolve debrid streams themselves; Settings › Integrations › Debrid services only says to set the key up in a stream addon and links to `/addons`. `debrid.*` was dropped from `SecretKey` in `lib/secrets.ts`.

**Why:** the user expects addons to take over debrid setup and keys; a second copy of the key in Sinag could drift from the addon's, and only an account-status display would need it.

**How to apply:**
- Don't add debrid connect/disconnect, token fields or service API calls unless a revisit trigger in ADR-0038 holds (an addon expects the client's key, hash-only cache checks, send-to-debrid, #101 cleanup). Then the token goes in the keychain as `debrid.<service>`.
- Plan/key problems surface through resolve's `denied` notice (ADR-0037), which tells the user to check the addon's settings.
- #97 (AllDebrid/Premiumize markers) needs test accounts from the user, who only has TorBox ([[debrid-test-key]]).
- Related: [[stream-resolve]], [[stream-ranking]], [[addon-manager]].
