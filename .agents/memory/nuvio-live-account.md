---
name: nuvio-live-account
description: "The user's real Nuvio account creds live in spikes/nuvio-backend/.env (git-ignored); how to use them safely"
metadata:
  node_type: memory
  type: reference
  originSessionId: b1a9ab61-e6d0-4acc-ba41-5b952f680d9e
  modified: 2026-10-11T14:33:36.230Z
---

The user's own Nuvio account (email/password) is in `spikes/nuvio-backend/.env` (git-ignored). The probe there (`node src/probe.ts …`) signs in to `api.nuvio.tv`, and the session is saved in `.session/live.json`.

- Never print the values. The password contains `#`, so it must stay quoted in `.env`, otherwise the parser cuts it at the `#` as a comment.
- It's a real account. Only push writes that get undone (`push-progress` then `delete-progress`). Don't flood it or create watched items; `push-throttle` and `ratelimit` refuse to run against live.
- Before committing results, scan them for the email, the user UUID and tokens. The `sb-auth-user-id` response header once leaked the UUID into the results.
- QR sign-in (#21, 2026-10-20) no longer needs the user's phone: Nuvio's device login is approved at nuvio.tv/link (any browser) or by `approve_device_login_session` from a password session. `SINAG_NUVIO_LIVE=1 go test -run TestLiveDeviceLogin ./internal/nuvio/` does that and signs both sessions out. Codes last 5 minutes; a code for the user to scan by hand still waits until they say they're ready.
- The local self-host stack (Docker project `nuvio`) was cloned into an earlier session's scratchpad, so it may be gone. Clone `NuvioMedia/self-host` again if needed.

- Go has an opt-in live check: `set -a; source spikes/nuvio-backend/.env; SINAG_NUVIO_LIVE=1 go test -run TestLive ./internal/nuvio/` (signs in, pulls profiles, signs out). Sign out with `context.Background()` in cleanups: `t.Context()` is already cancelled there, which left one orphan session on 2026-10-19.
- Since Oct 2026 Nuvio's `register_current_session` / `list_my_sessions` accept only "Nuvio Web/Mobile/TV/Desktop"; Sinag must not register under those names (ADR-0008).

- Profile writes (#95): `SINAG_NUVIO_LIVE_WRITES=1 go test -run TestLiveProfiles ./internal/nuvio/` renames profile 1 and back, adds and deletes a profile, and checks every field is restored. The account had one profile on 2026-10-20.

Related: [[spike-ticket-workflow]], [[debrid-test-key]]
