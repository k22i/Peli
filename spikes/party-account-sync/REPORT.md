# Spike: the party code in synced account data

Follow-up to [`../party-account-topic/REPORT.md`](../party-account-topic/REPORT.md),
which found Nuvio authorizes no account-scoped realtime channel. This tests the
other route: put the party code in the account's **synced data**, which every
profile of the account already reads, so a Join page can list the account's live
parties and join in one click.

Probed live against `https://api.nuvio.tv` on the user's real account, with two
sessions of that account and its **two real profiles** (index 1 and index 2).
Raw output in [`results/`](results); everything is redacted (email, user UUID,
tokens, party code, profile names and avatars).

## Verdict

**Viable.** The code round-trips through synced account data in about a third of
a second in each direction, another profile of the same account reads it, one
`GET` lists the whole account's announcements, and every write was undone and
verified gone. The costs are not technical: it is a **write into a table Nuvio's
own clients own** (only ever under a Peli-owned platform key), discovery is a
pull rather than a push, and cleaning up stale announcements is Peli's job.

## Where it lands

Nuvio's `/rest/v1/profile_settings_blobs` table holds one JSON blob per
`(profile_id, platform)`. The account already has two rows — `1/desktop` and
`1/tv` — written by Nuvio's own clients, each with a server-side `updated_at`.
Nuvio's clients pull the platform they are; a platform key they never ask for is
invisible to them. Peli does not touch this table at all today (its sync writes
library, progress, watched, addons, plugins and profiles only), so `peli` is a
free key:

```
sync_push_profile_settings_blob(p_profile_id, p_platform, p_settings_json jsonb, p_origin_client_id)
sync_push_profile_settings_blob_guarded(p_profile_id, p_platform, p_settings_json, p_expected_updated_at)
sync_pull_profile_settings_blob(p_profile_id, p_platform)
GET /rest/v1/profile_settings_blobs?select=profile_id,settings_json,updated_at&platform=eq.peli
```

What a row looks like once written (the announcement this spike used):

```json
{"profile_id":1,
 "settings_json":{"v":1,"party":{"id":"<uuid>","code":"<code>","host":"<profile-1-name>",
   "media":{"type":"movie","meta_id":"tt0000001","title":"Peli spike"},"at":1764200000000}},
 "updated_at":"…"}
```

## Evidence

| step | call | result |
|---|---|---|
| write the announcement (profile 1) | `sync_push_profile_settings_blob` | `HTTP 204`, **346 ms** |
| second session reads it back | `sync_pull_profile_settings_blob(1, "peli-spike")` | exact JSON, **420 ms** |
| the other profile reads the host's row | `sync_pull_profile_settings_blob(1, …)`, the call a device showing profile 2 makes | carries the code, **356 ms** |
| one call lists the whole account | `GET …?platform=eq.peli-spike` | both profiles' rows, **361 ms** |
| write a row per profile, so each reads its own | `sync_push_profile_settings_blob` ×2 | `204`, `204`; profile 2 reads its own |
| write/read another profile's row (index 2) | push + pull at index 2 | `204`; readable (deleted after) |
| optimistic concurrency | `_guarded` with a stale `updated_at` | `HTTP 409 {"code":"PT409","message":"Settings changed on another device. Reload and try again."}` |
| …and with the right one | `_guarded` | `HTTP 200` + the new `updated_at` |
| a bigger blob | 32 KiB `settings_json` | round-trips, 32 903 bytes back |
| a stale code at join time | `watch_party_preview("TEST01")` | `{"error":"party_not_found"}` |
| undo | `DELETE …?profile_id=eq.N&platform=eq.peli-spike` | `204`; account identical to baseline |

Read timings, three rounds each, on an empty answer: pull RPC 344–409 ms,
listing GET 340–373 ms. Writes were 346 ms and 360 ms.

Two API gotchas found:

- `sync_pull_profile_settings_blob(p_profile_id)` alone is **ambiguous** between
  its one- and two-argument overloads: `HTTP 300 PGRST203`, "Could not choose the
  best candidate function between … (p_profile_id => integer) … (p_profile_id =>
  integer, p_platform => text)". Always pass `p_platform`, or use the table `GET`.
- The table read is the cheap listing: one request, every profile, no RPC.
- Profiles are an **argument, not a second authorization**: a session belongs to
  the account, and `p_profile_id` selects whose row is read or written. That is
  why one session can read profile 1's row while showing profile 2 — the same
  reason `UsesPrimaryAddons` works in Peli today.

## What a design would use

- **Platform key** `peli`, never a real one (`desktop`, `tv`, …). Writing a real
  platform's blob would replace the user's actual settings on that device type.
- **Blob**: `{"v":1,"party":{"id","code","host","media":{"type","meta_id","title"},"at"}}`
  — about 200 bytes; the cap was not found (32 KiB works).
- **Writer**: on party create, push the row for the host's profile. On party end,
  delete it. `_guarded` with the `updated_at` it last saw, so two Peli clients
  can't clobber each other; a conflict is a clear 409 to retry from.
- **Reader** (the Join page): one
  `GET /rest/v1/profile_settings_blobs?select=profile_id,settings_json,updated_at&platform=eq.peli`
  ≈ 360 ms, for every profile of the account at once. Drop rows whose `at` is
  older than a few hours, then confirm each with `watch_party_preview(code)`
  (already an RPC Peli has) — `party_not_found` means the party ended and the row
  is stale. Then `watch_party_join(p_code, …)`: one click, no typing a code.
- **Per profile or across profiles**: reading the host's row works (356 ms), so
  the host writes one row. If Peli would rather every profile read only its own
  row, writing one row per profile also works (one `sync_pull_profiles` gives the
  indexes).
- **Cost**: 2 writes per party (start, end) plus 1 read per Join page open —
  nothing periodic. Well inside Peli's own 20 req/s limiter and Nuvio's 900/s.
- **Freshness**: this is a pull, not a push. A party that starts while the Join
  page is already open appears on the next fetch; Peli's existing triggers
  (launch, window focus, the 5-minute poll) already do that, and the Join page
  could fetch on open and on focus.

## Untested and caveats

- **It writes to Nuvio's backend, and that is a product decision, not a technical
  one.** ADR-0004 makes the sync module "a good guest" and the PRD forbids pushing
  the home layout and collections to Nuvio's server; watch parties already use
  Nuvio's backend "for something new for a third-party client" (ADR-0051). A
  `peli` platform row is a third kind of write: small, deletable, invisible to
  Nuvio's UI as far as we can tell — but it is Peli leaving a row in someone
  else's table, and it belongs in the same conversation as #93.
- **Nuvio's own clients were not exercised.** Nothing here shows what a Nuvio app
  does when it sees an unknown platform row — the reads are per platform, so the
  expected answer is "ignores it", but a purge job would make the row vanish, and
  only Nuvio's code or a live Nuvio client could say.
- **Staleness is Peli's job.** There is no server-side TTL. A host that crashes
  leaves a row until someone deletes it; readers must ignore old `at` values and
  let `watch_party_preview` settle it at join time. Neither the TTL nor a crash was
  simulated, only the preview check against a bogus code.
- **The 32 KiB ceiling** is a floor on the limit: something bigger was never
  tried, and Peli's needs are ~200 bytes.
- **Rate limits, 429 and retry behaviour** were not probed: two writes and a
  handful of reads never came close.
- **"Works anywhere" means any Peli signed into that account, online.** Not
  Nuvio's own apps (they don't know the key), not another account (the rows are
  RLS-scoped to the account — every read here was with that account's own token),
  and not offline.
- **Nothing was left behind.** Every row was written under the throwaway platform
  `peli-spike` and deleted; the final state was checked twice:
  `?platform=eq.peli-spike` → `[]`, and the account's only rows are the original
  `1/desktop` and `1/tv` with their original `updated_at` values. Sessions were
  signed out with `context.Background()`. No party was created in this spike, no
  profile or account was created or changed, and nothing was written to
  `.agents/memory`.

## How to rerun

The spike is in the root Go module (no `go.mod` of its own), so it can import
`internal/nuvio`:

```sh
cd /Users/kevinmallari/Developer/staysh
set -a; source spikes/nuvio-backend/.env; set +a

go run ./spikes/party-account-sync explore   # read-only inventory: paths, params
go run ./spikes/party-account-sync run3      # the design flow over both profiles
go run ./spikes/party-account-sync run       # one profile: round-trip, guard, 32 KiB
go run ./spikes/party-account-sync timing     # read timings
```

`run` and `run3` write to the real account and undo everything: both check that
the account is byte-identical to the baseline afterwards, and `run` refuses to
write at all if it cannot delete a row. Each prints only redacted output.
