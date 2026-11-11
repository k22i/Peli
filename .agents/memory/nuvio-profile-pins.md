---
name: nuvio-profile-pins
description: "Nuvio's profile PIN RPCs and shapes, and how Peli gates and stores them"
metadata:
  type: reference
---

Nuvio's profile PINs, as Peli uses them (#25). All are PostgREST RPCs; the contract is the Apache-2.0 self-host schema (`database/migrations/00000000000000_baseline.sql`), not Nuvio's apps (CONTRIBUTING.md's clean-room rule).

- `sync_pull_profile_locks()` returns rows `profile_index, pin_enabled, pin_locked_until` (timestamptz, null when not locked out). `sync_pull_profiles` returns the same two fields.
- `verify_profile_pin(p_profile_id, p_pin)` returns rows `unlocked, retry_after_seconds`. It is a table-returning RPC, so PostgREST answers with a JSON array: decode rows, not one object. (Decoding one object was the `cannot unmarshal array into Go value of type nuvio.VerifyProfilePINResult` bug in #25.)
- `set_profile_pin(p_profile_id, p_pin, p_current_pin DEFAULT NULL)` and `clear_profile_pin(p_profile_id, p_current_pin DEFAULT NULL)`: both void. The PIN must be exactly four digits (`^[0-9]{4}$`). Changing or removing an existing PIN needs `p_current_pin`; omit the key rather than sending an empty string, or the backend raises "Current PIN is required to change/remove PIN" (PostgREST 400, code `P0001`). Set and clear don't count failed attempts; only `verify_profile_pin` locks out after too many wrong tries (five minutes).
- `clear_profile_pin_with_account_password` is a recovery path Peli doesn't call. Peli never pushes PIN fields; `sync_push_profiles` leaves them alone.

In the app, Go marks a profile unlocked for the run after a correct PIN (`account.UnlockProfile`), and `SwitchProfile`/`EditProfile`/`DeleteProfile` refuse a locked profile that isn't. The frontend keeps the unlocked set under the TanStack Query key `["profiles-unlocked"]`, deliberately outside the `["profiles"]` prefix so `profileChanged`'s `invalidateQueries(["profiles"])` doesn't clear it on a switch.

Related: [[nuvio-live-account]], [[spike-ticket-workflow]].
