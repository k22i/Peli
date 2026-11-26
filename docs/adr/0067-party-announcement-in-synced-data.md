---
status: accepted
date: 2026-11-26
---

# Announcing a live watch party in the account's synced data

A watch party is joined with a six-character code, and only a host who shares it can bring anyone in. Someone on the same Nuvio account, on another device or profile, has to be *told* the code. The aim is that a profile's Join page lists the account's live parties and joins one in a click, with no code to share.

Nuvio has no call that lists an account's parties, `watch_party_join` needs the code, and its realtime server authorizes no account-scoped channel, so nothing on Nuvio's side can tell a profile that a party exists (`spikes/party-account-topic/REPORT.md`). Peli therefore announces the party itself, in the account's **synced data**, which every profile of the account already reads (`spikes/party-account-sync/REPORT.md`).

## Decisions

1. **The announcement is a settings blob, under a platform key Peli owns.** `/rest/v1/profile_settings_blobs` keeps one JSON object per `(profile_id, platform)`. Peli writes its own under platform `peli` and never one of Nuvio's (`desktop`, `tv`, …): a real platform's blob is the user's actual settings for that kind of device, and replacing it would throw them away. Nuvio's clients pull the platform they are, so a `peli` row is invisible to them.
2. **What goes in it is small and about the party, not the person.**

   ```json
   {"v":1,"party":{"id":"…","code":"ABC123","host":"Ana","profile":1,
     "media":{"type":"movie","meta_id":"tt0111161","title":"…"},
     "started_at":1764200000000}}
   ```

   The host writes it on its own profile's row when the party starts, and rewrites it when the party moves to another title or episode. `End`, `Leave`, a party this device no longer hosts, and a replaced session take it away again. A write is guarded with the row's `updated_at` (`sync_push_profile_settings_blob_guarded`), so two Peli clients can't clobber each other, and the row is replaced whole, so a key Peli doesn't own is copied back by the same read-modify-write.
3. **The list is a pull, and the preview is what's authoritative.** `Party.AccountParties` reads the whole account's rows in one `GET …?platform=eq.peli` (≈360 ms), drops anything older than 8 h, and confirms each with `watch_party_preview(code)`: `party_not_found` means the party ended, and the row is deleted on the way past. The preview also supplies what's playing, the host and the seat count, so the listing can't drift from the party. A stale row a crashed host left is swept by age and by that check, and by the sweep on each fetch.
4. **Joining changes nothing.** The list's **Join** button calls the same `Party.Join(code)` as the code field.
5. **It never blocks a party.** Announcing and withdrawing run in their own goroutines with their own timeouts, outside the playback path and off the party's channel goroutines. An announcement that fails (offline, 429, a 409 that survived one retry) is logged and forgotten: the party goes on, the listing is missing, and typing a code still works. The feature degrades to what Peli did before it.
6. **Freshness is by pull.** The Join page fetches when it opens and when the window comes back (`staleTime` 30 s, `refetchOnWindowFocus`), and never polls faster; there is no interval and nothing added to the syncer's surfaces — this is transient, not user data, and it never touches the store.
7. **Kids profiles get no list**, failing closed in Go (`AccountParties` is empty when parties are unavailable, including `kids_profile`), as addon visibility does. Rows are row-level-security scoped to the account, so nothing crosses accounts, and there is no cross-account sharing.

## Why this and not something else

- **A realtime channel per account is refused.** Every account-ish topic (`account:`, `user:`, `peli:`, `profile:`, …) answers `watch_party_topic_allowed: false` and the socket says `Unauthorized`; only an existing party's `watch-party:<id>` is joinable, and nothing can discover the id (`spikes/party-account-topic/REPORT.md`).
- **The synced-data route already exists and is already read by every profile.** The spike proved the round trip on the user's real account with its two real profiles: a write in 346 ms, a read in 420 ms, the other profile reading the host's row in 356 ms, the whole account in one `GET` in 361 ms, compare-and-set refusing a stale `updated_at` with `409 PT409`, 32 KiB fitting, and a delete leaving the account byte-identical to its baseline.
- **Being a good guest (ADR-0004) is still the rule.** This is a small, deletable row under a key Nuvio never reads, not user data pushed into Nuvio's schema; the PRD's ban on pushing the home layout and collections stands, and they still go only to a custom server (ADR-0022). ADR-0051 already uses Nuvio's backend "for something new for a third-party client", and this is the same bargain one step further: Peli leaves a row in someone else's table. The user was asked and said yes (#93).

## Risks, and what they cost

- **Nuvio could ignore, purge or forbid the row.** It is not a contract: there is no version signal, the party functions aren't in the OpenAPI document, and a purge job would make the list empty. The feature is best-effort by design, so the failure mode is a missing list, never a broken party.
- **A crashed host leaves a row** until the 8 h age filter or `watch_party_preview` drops it.
- **Rollback is a client change.** Stop writing, and delete the rows with `DELETE /rest/v1/profile_settings_blobs?platform=eq.peli`. No server work, no migration.
- **The code is a credential.** It lives only in the account's own sync row and in memory, and it is never logged.

## Untested

- What a Nuvio client does when it sees a `peli` row: the expected answer is "ignores it" (reads are per platform), but a purge job would only show in Nuvio's code or on a live Nuvio client.
- A real two-device run of the listing: one party on profile 1 in Peli, the Join page on profile 2 in another Peli. The live test (`TestLivePartyAnnouncement`) proves announce → list → preview → withdraw against the real account, not two clients at once.
- Rate limits and 429s under real click pressure; two writes and one read per party are far inside Nuvio's own limits.
