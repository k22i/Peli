# Implementation plan: announce a live watch party in synced account data

Saved at `spikes/party-account-sync/PLAN.md`. Written for a fresh session with no
memory of the spikes; read the evidence first (task 0).

## Goal

A profile's **Join page lists the account's live parties** and joins one in a
click, with no code to share. Nuvio has no RPC that lists an account's parties
and `watch_party_join` needs `p_code`, so Peli announces the party itself, in the
account's **synced data**, which every profile of that account already reads.

## Evidence (two spikes, both live, both undone)

- `spikes/party-account-topic/REPORT.md` — Nuvio's realtime server refuses every
  account-scoped channel (`Unauthorized: You do not have permissions to read from
  this Channel topic: account:<uuid>`); the only joinable topic is an existing
  party's own `watch-party:<id>`, whose id nothing can discover. **No realtime
  route.**
- `spikes/party-account-sync/REPORT.md` — the route that works:
  `/rest/v1/profile_settings_blobs`, one JSON blob per `(profile_id, platform)`,
  written with `sync_push_profile_settings_blob` (+ `_guarded` for
  compare-and-set), read with `sync_pull_profile_settings_blob` or one table
  `GET`. Proven on the user's account with its two real profiles: write 346 ms,
  read 420 ms, other profile reads the host's row 356 ms, one `GET` lists every
  profile's row in 361 ms, stale `updated_at` → `409 PT409`, 32 KiB fits, delete
  → `204` and the account is byte-identical to baseline.
  Spike code to copy from: `spikes/party-account-sync/main.go`.

## Decision needed from the user (confirm before shipping, not before starting)

This writes a small row into **Nuvio's own table**, under a platform key Nuvio's
clients never ask for. ADR-0004 makes the sync module "a good guest" and the PRD
forbids pushing the home layout and collections to Nuvio's server; ADR-0051
already uses Nuvio's backend "for something new for a third-party client". Put it
in front of the user with the numbers above and get an explicit yes. It belongs
in the same conversation as #93.

## Design (settled by the spike)

- **Surface**: `profile_settings_blobs`, **platform key `peli`** — never a real
  one (`desktop`, `tv`, …): pushing a real platform would replace the user's
  actual settings for that device type.
- **Blob** (the whole point is that it is small):

  ```json
  {"v":1,"party":{"id":"<party id>","code":"<code>","host":"<display name>",
    "profile":1,"media":{"type":"movie","meta_id":"tt0000001","title":"…"},
    "started_at":1764200000000}}
  ```

  The blob is replaced wholesale, so any future Peli key in it must be merged by
  the same read-modify-write path, never overwritten blind.
- **Write**: once, on the host's own profile row, after `watch_party_create`
  succeeds. Rewrite when the party's media changes (same place `publishMedia`
  runs), so the listing keeps up. **Delete** the row on `End`, and when the host
  leaves a party it no longer hosts.
- **Read**: one request — `GET /rest/v1/profile_settings_blobs?select=profile_id,settings_json,updated_at&platform=eq.peli`
  — then per row: parse, drop anything older than 8 h, and confirm with
  `watch_party_preview(code)`. Preview is authoritative (`party_not_found` means
  the party ended) and it also gives what's playing, the host and the member
  count for the list. Delete the stale row on the way past, best-effort.
- **Join**: the existing `Party.Join(code)`. One click; nothing new on the wire.
- **Never blocks a party**: an announcement failure (offline, 429, 409 after a
  retry) logs and is forgotten. Typing a code still works, so the feature degrades
  to today's behaviour.
- **Freshness**: this is a pull. Fetch on Join-page open and on window focus; do
  not poll faster than 30 s and do not add it to the syncer's surfaces (it is
  transient, not user data, and it must not touch the store).

## Non-goals

- No realtime announcement (proven refused), no new Nuvio RPC, nothing Nuvio's
  own apps would display.
- No change to party create/join/presence/chat, no sync-surface or store changes.
- No cross-account sharing: rows are RLS-scoped to the account, which is right.

## Tasks

0. Read both spike reports above and skim `spikes/party-account-sync/main.go`.
1. **`internal/nuvio/settings_blob.go`** (new): `SettingsBlobRow{ProfileID,
   Settings json.RawMessage, UpdatedAt string}` and
   `ProfileSettings(ctx, s, index, platform)`, `ProfileSettingsList(ctx, s,
   platform)` (the table GET, `Accept` JSON row set),
   `PushProfileSettings(ctx, s, index, platform, blob)` and
   `PushProfileSettingsGuarded(ctx, s, index, platform, blob, expectedUpdatedAt)`.
   Always send `p_platform` — the one-argument pull is ambiguous (`PGRST203`).
   Add every new path to `contract` in `internal/nuvio/contract_test.go` (it
   fails otherwise: `TestContractCoversEveryCall`), a case in `TestContract`, and
   the fake to `internal/nuviotest`.
2. **`internal/backend/party.go`**: pass the four calls through as
   `Parties.AccountParty*`, with the types aliased like the rest of that file, so
   nothing outside `internal/backend` imports `internal/nuvio`.
3. **`internal/party/announce.go`** (new): `Announcement` type, `announce()`
   (write, guarded, one retry on `409` after a re-read), `withdraw()`, and
   `AccountParties()` (list → parse → age filter → preview → drop stale rows →
   dedupe by party id). Keep the network work off the party's own goroutines and
   out of the playback path.
4. **`internal/party/service.go`**: call `announce()` where the host's party
   starts and where `publishMedia` moves it, `withdraw()` in `End` and in the
   host-handing-on path; add the bound `AccountParties()` for the Join page;
   announce a `party:notice` kind when a fetched party is dropped as stale, and
   keep the whole thing quiet when parties are unavailable.
5. **Frontend**: `lib/party.ts` — `useAccountParties()` (TanStack query, key
   `["party","account"]`, refetch on window focus, stale time 30 s) and an
   `AccountParties` type; `components/party/account-parties.tsx` — the list
   (poster, title, host, member count, **Join** button → `Join(code)`), empty
   state, and a skeleton while loading; render it above `<JoinParty />` in
   `routes/party.tsx`'s "Join a watch party" column. Add `AccountParties` to the
   `@bindings/party` mock in `src/test/setup.ts` (unmocked, the Wails call goes
   through the stubbed `fetch` and breaks `serve`) and a fixture next to
   `partyState`/`partyMember`. Kids profiles: no list (fail-closed like addons).
6. **Live test** `internal/party/live_test.go` or `internal/nuvio/live_test.go`
   (`PELI_NUVIO_LIVE_WRITES=1`), patterned on `TestLiveParty`/`TestLiveProfiles`:
   create a party, assert the row appears, pull it, end the party, assert the row
   is gone, sign out with `context.Background()`, and check the account's rows are
   back to the baseline.
7. **Docs and memory**: ADR-0067 (the decision, the surface, the good-guest
   argument, the fallbacks) plus an addendum line in
   `docs/adr/0051-watch-party.md`; update `.agents/memory/watch-party.md` and
   `.agents/memory/nuvio-party-rpc-surface.md` (they currently say discovery is
   impossible — it now has a route), and add the MEMORY.md index line if a new
   memory file is created.
8. **Gate**: `go vet ./...`, `go test ./internal/nuvio/ ./internal/party/
   ./internal/backend/ ./internal/store/`, the iOS boundary test
   (`internal/party` is already in the iOS dependency set, so a new file there is
   fine), `pnpm check` in `frontend/`, then the manual two-profile run below.

## Verification

- Live: `set -a; source spikes/nuvio-backend/.env; set +a; PELI_NUVIO_LIVE_WRITES=1
  go test -run TestLivePartyAnnouncement ./internal/party/` — and the spike still
  runs standalone for a sanity check (`go run ./spikes/party-account-sync run3`).
- Manual, on the real account: start a party on profile 1 in Peli, open
  `/party` on profile 2 in a second Peli (or the same app switched) → the party is
  listed within one fetch (~0.4 s), Join lands in it in one click, and the row is
  gone after the host ends it.
- Regression: a party created offline announces nothing, and joining by code
  still works.

## Risks and rollback

- **Nuvio could ignore, purge or forbid the row.** It is not contractual (no
  version signal). The feature is best-effort by design, so the failure mode is
  a missing list, never a broken party.
- **A crashed host leaves a row.** Swept by the 8 h age filter and by
  `watch_party_preview` at read time; a sweep on announce/list deletes the rest.
- **Rollback** is a client change only: stop writing, and delete the rows with
  `DELETE /rest/v1/profile_settings_blobs?platform=eq.peli`. No server work, no
  Nuvio change, nothing to migrate.
- **Privacy**: the code is a credential; it lives only in the account's own sync
  row and in memory. It is never logged (the spike's redaction rule stands).
