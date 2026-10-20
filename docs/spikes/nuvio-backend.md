# Spike: Nuvio backend access

Issue: [#5](https://github.com/k22i/Sinag/issues/5) · Epic: [#1](https://github.com/k22i/Sinag/issues/1) · Feeds: [#28](https://github.com/k22i/Sinag/issues/28) (sync module), [#33](https://github.com/k22i/Sinag/issues/33) (sync contract tests), [#8](https://github.com/k22i/Sinag/issues/8) (M0 gate) · Date: 2026-10-11
Spike code: [`spikes/nuvio-backend/`](../../spikes/nuvio-backend/) (throwaway). Raw results: [`spikes/nuvio-backend/results/`](../../spikes/nuvio-backend/results/) (`live-*` = `api.nuvio.tv`, `local-*` = self-host stack; values replaced by their types).

## Verdict

**Go.** A third-party desktop client can sign in to `api.nuvio.tv` and pull and push sync data with plain supabase-js, using only public, documented inputs.

- **No secret to ship.** The client key is the backend's public publishable key, served at `GET /.well-known/nuvio`. Nothing is scraped from an app bundle or committed.
- **Both sign-in paths work on live.** Email/password: 433 ms, 7-day access token. QR / device code with the Nuvio phone app: approved in 28 s, then `tv-logins-exchange` returns a normal Supabase session.
- **All 20 read calls work on live**, and the delta cursors line up with their feeds. A pushed progress entry was visible to a second session **374 ms** later and **showed up in Nuvio mobile right away**. Deleting it produced a `delete` event in the delta feed.
- **The contract is open source.** Nuvio's backend is [`NuvioMedia/self-host`](https://github.com/NuvioMedia/self-host) (Apache-2.0: Supabase, SQL schema, edge functions), and live answers the same way. We can write against its schema and run it locally for contract tests (#33), without reading NuvioMobile (GPL-3) or nuvio-web (no licence).

**Recommendation:** build #28's Nuvio backend as a thin layer over the RPCs below (in the end Go over plain HTTP, not supabase-js: [ADR-0008](../adr/0008-nuvio-client-in-go.md)), with a local `NuvioMedia/self-host` stack as #33's test target. Five server behaviours shape the design and must be in #28's spec: [silently dropped progress pushes](#gotchas-for-28), replace-all addon pushes, global event IDs, a rate-limit budget that seems to be shared, and 429s without `Retry-After`.

## How this was tested (read before trusting the numbers)

- **Live:** `api.nuvio.tv` on 2026-10-11, the user's own account (one profile, 5 addons, empty library / progress / watched before the test), from this Mac. The phone was the Nuvio app on the user's phone. One progress entry was pushed to a public-domain film (*Big Buck Bunny*, `tt1254207`), checked on the phone, then deleted.
- **Local:** `NuvioMedia/self-host` at [`39ea2bd`](https://github.com/NuvioMedia/self-host/commit/39ea2bd) (2026-08-26) in Docker, with throwaway accounts. A second local account approved QR codes in place of the phone. Write-heavy cases (`push-throttle`) and flooding (`ratelimit`) ran **only here**, never on live.
- **Live timings are mostly network.** Calls took ~350 ms, but Kong reports 1–34 ms upstream (`x-kong-upstream-latency`). The ping round trip to `api.nuvio.tv` was ~175 ms from here. Locally every call is under ~15 ms.
- The live account had no library, progress or watched rows. Row shapes for those surfaces come from the local runs and the schema. Live shapes were checked on the one progress entry we pushed.

## Access

| | |
|---|---|
| Base URL | `https://api.nuvio.tv` (Cloudflare → Caddy → Kong 3.9.1 → PostgREST / GoTrue / edge functions) |
| Key | `GET /.well-known/nuvio` → `{version, service, self_hosted, backend_url, publishable_key, capabilities: {email_password_auth, tv_login}}`. Send it as `apikey` on every request. `self_hosted: true` on live too. |
| Custom backends | Same discovery doc on any self-host, so "custom backend" in #28 can be just a URL. |
| User agent | Ours (`Sinag/<version> (+https://github.com/k22i/Sinag)`). Sessions show up in the user's `list_my_sessions` with platform parsed from it. `register_current_session(p_client_name, p_client_version, p_platform, p_device_name)` names the client properly. **Since changed (#20):** it now accepts only Nuvio's own app names, and `list_my_sessions` lists only those ([ADR-0008](../adr/0008-nuvio-client-in-go.md)). |

**Email/password:** `auth.signInWithPassword`. Live access tokens last **604,800 s (7 days)**, with a refresh token. Wrong credentials: HTTP 400, `invalid_credentials` (also in `x-sb-error-code`).

**QR / device code** (no password typed on the desktop):

1. As anon: `start_tv_login_session(p_device_nonce, p_redirect_base_url, p_device_name)` → `{code, web_url, expires_at, poll_interval_seconds}`. The nonce is a random secret that stays on the device. Show `web_url` (`https://nuvio.tv/tv-login?code=…`) as a QR code. `p_device_name` is what the phone shows.
2. The phone app (signed in) scans it and calls `approve_tv_login_session(p_code)`.
3. Desktop polls `poll_tv_login_session(p_code, p_device_nonce)` every `poll_interval_seconds` (~3 s on live) → `status`: `pending` → `approved`, or `expired`. **Codes last 5 minutes** (live: started 14:25:04, `expires_at` 14:30:04). Our first live attempt expired before anyone scanned it, so the UI needs a visible countdown and a one-click "new code".
4. `POST /functions/v1/tv-logins-exchange {code, device_nonce}` → `{access_token, refresh_token, token_type, expires_in}` → `auth.setSession`.

**Since changed (#21):** Nuvio added `start_device_login_session(p_device_nonce, p_redirect_base_url, p_device_name, p_device_type)` on 2026-10-16 ([self-host migration 11](https://github.com/NuvioMedia/self-host/blob/main/database/migrations/00000000000011_hosted_sync_updates.sql)), live by 2026-10-20. It returns a `device_code` for polling and exchanging as above, plus a six-character `user_code` and `verification_uri_complete` (`https://nuvio.tv/link?code=…`). A signed-in account approves at Nuvio's "Link a device" page with `approve_device_login_session(p_user_code)`, so any phone browser works, not only the Nuvio app. The redirect base must contain `/link`. Sinag uses it ([ADR-0013](../adr/0013-qr-sign-in-via-nuvio-link.md)). After the exchange, a poll answers `exchanged`.

## Function catalog

Everything a desktop client needs, ~30 functions. Every `sync_*` takes `p_profile_id` (profile **index** 1–6, not the profile UUID). Writes also accept `p_origin_client_id` (a client ID, recorded with the change). "✅ live" means called on `api.nuvio.tv` in this spike; the rest are from the schema and ran on the local stack.

**Session and account**

| Function | Args | Returns | |
|---|---|---|---|
| `get_sync_owner` | – | `uuid` | ✅ live |
| `get_sync_overview` | – | `jsonb` row counts per surface and profile | ✅ live |
| `list_my_sessions` / `revoke_my_session` | – / `p_session_id` | sessions with client, platform, device, `is_current` | ✅ live (list) |
| `register_current_session` | `p_client_name, p_client_version?, p_platform?, p_device_name?` | `boolean` | schema |
| `start_tv_login_session` / `poll_tv_login_session` | see above | see above | ✅ live |

**Profiles and settings**

| Function | Args | Returns | |
|---|---|---|---|
| `sync_pull_profiles` | – | `id, profile_index, name, avatar_color_hex, avatar_id, avatar_url, uses_primary_addons, uses_primary_plugins, pin_enabled, pin_locked_until, …` | ✅ live |
| `sync_pull_profile_locks` / `verify_profile_pin` | – / `p_profile_id, p_pin` | `pin_enabled, pin_locked_until` / `unlocked, retry_after_seconds` | ✅ live (locks) |
| `get_avatar_catalog` | – | 42 avatars: `id, display_name, storage_path, category, bg_color, …` | ✅ live |
| `sync_pull_profile_settings_blob` / `sync_push_profile_settings_blob` | `p_profile_id, p_platform` (+ `p_settings_json`) | `settings_json` (versioned features blob: theme, TMDB, debrid, …) | ✅ live (pull) |
| `sync_pull_home_catalog_settings` / `sync_push_home_catalog_settings` | `p_profile_id, p_platform` (+ `p_settings_json`) | per-platform home rows | ✅ live (pull) |
| `sync_pull_collections` / `sync_push_collections` | `p_profile_id` (+ `p_collections_json`) | `collections_json`: folders of addon catalog sources | ✅ live (pull) |

`p_platform` defaults to `'tv'`. We sent `'desktop'` and got an empty row set for home catalog settings, so #28 has to decide whether desktop gets its own settings or shares another platform's.

**Library, progress, watched**: the core of story-level sync. Each has a full pull, a delta feed and its cursor.

| Function | Args | Returns | |
|---|---|---|---|
| `sync_pull_library` | `p_profile_id, p_limit=500, p_offset=0` | `library_items` rows | ✅ live |
| `sync_pull_library_delta` | `p_profile_id, p_since_event_id, p_limit=1000` | `event_id, operation, content_id, content_type, name, poster, poster_shape, background, description, release_info, imdb_rating, genres, addon_base_url, added_at` | ✅ live |
| `sync_push_library_items` / `sync_delete_library_items` | `p_items` / `p_keys`, `p_profile_id, p_origin_client_id` | `void` | local |
| `sync_pull_watch_progress` | `p_profile_id, p_since_last_watched?, p_limit?` | `watch_progress` rows (`progress_key, content_id, content_type, video_id, season, episode, position, duration, last_watched`) | ✅ live |
| `sync_pull_watch_progress_delta` | `p_profile_id, p_since_event_id, p_limit=1000` | `event_id, operation, progress_key, …same fields` | ✅ live |
| `sync_push_watch_progress` | `p_entries, p_profile_id, p_origin_client_id` | `void` | ✅ live |
| `sync_delete_watch_progress` | `p_keys` (progress keys), `p_profile_id, p_origin_client_id` | `void` | ✅ live |
| `sync_pull_watched_items` | `p_profile_id, p_page=1, p_page_size` (default 100,000) | `watched_items` rows | ✅ live |
| `sync_pull_watched_items_delta` | `p_profile_id, p_since_event_id, p_limit=1000` | `event_id, operation, content_id, content_type, title, season, episode, watched_at` | ✅ live |
| `sync_push_watched_items` / `sync_delete_watched_items` | `p_items` / `p_keys`, `p_profile_id, p_origin_client_id` | `void` | local |
| `sync_get_{library,watch_progress,watched_items}_delta_cursor` | `p_profile_id` | `bigint`: latest event ID | ✅ live |

**Addons and plugins:** there is no pull RPC. Read the tables through PostgREST, protected by row-level security: `GET /rest/v1/addons?profile_id=eq.N&order=sort_order` (`url, name, enabled, sort_order, …`, ✅ live, 5 rows), same for `plugins`. Write with `sync_push_addons` / `sync_push_plugins` (`p_addons` / `p_plugins`, `p_profile_id, p_origin_client_id`).

Not needed by a v1 desktop client, so not catalogued: provider and tracker credentials, account backup / restore, PIN set / clear, `delete-account`.

**Profile editing (added in #95).** Run on the local stack with a throwaway account ([`local-profiles.json`](../../spikes/nuvio-backend/results/local-profiles.json)), then checked on live with edits that were undone (see below). Nuvio's account dashboard uses the same three calls: the patch for edits, the full list for adding, the delete for deleting.

| Function | Args | Returns | |
|---|---|---|---|
| `sync_patch_profile` | `p_profile_id`, then any of `p_name`, `p_avatar_color_hex`, `p_uses_primary_addons`, `p_uses_primary_plugins`; `p_avatar_id` / `p_avatar_url` each with a `…_provided` flag | the profile row after the change | local, live |
| `sync_push_profiles` | `p_profiles` (`profile_index, name, avatar_color_hex, uses_primary_addons, uses_primary_plugins, avatar_id, avatar_url`), `p_client_max_profiles` | `void` | local, live |
| `sync_delete_profile_data` | `p_profile_id` (+ `p_origin_client_id`) | `void` | local, live |

- **The patch is sparse.** A null argument keeps the field: a name-only patch leaves the colour, avatar and addon sharing as they were, and a patch with nothing in it returns the row unchanged. Setting an avatar ID clears `avatar_url` and the other way round. It trims the name. It only edits a profile that exists: `P0002 Profile not found` otherwise, so it can't add one.
- **The patch's errors:** an empty name or an index outside 1–6 is `22023`. An avatar ID that isn't in the catalog is **`42501`**, the same code as a missing session. A client that reads `42501` as "signed out" would refresh and then send the user to sign in, so only send IDs from `get_avatar_catalog`.
- **`sync_push_profiles` differs between self-host and live, on paper.** On self-host (migration `00000000000011_hosted_sync_updates.sql`) it only upserts: a partial or empty list deletes nothing, and `p_client_max_profiles` can be left out. Nuvio's public API doc (`/docs/nuvio-public-api.md`, served by the account dashboard in self-host commit `30f1568`) still says it "fully replaces profiles" and **deletes the ones missing** from slots `1..p_client_max_profiles`, which defaults to 4. The migration says the upsert shipped on hosted first, but live wasn't tested with a partial list, because of what it would delete.
- **The push resets what it isn't sent.** Pushing an existing profile with its name alone set its colour back to `#1E88E5` and both `uses_primary_*` to false. It kept the avatar ID and the PIN (pushes never touch PIN fields). So a push needs every profile, freshly pulled, with every field: that's safe under either behaviour.
- **A new profile** gets Cinemeta and OpenSubtitles server-side (2 addons), with `uses_primary_*` false.
- **Deleting** removes the profile row and everything scoped to it: library, progress, watched, addons, settings. A profile added later in the same index starts empty. Deleting an index that's already gone is not an error.
- **`P0002 Profile not found` comes back as HTTP 500**, so a client that reads 5xx as "backend down" has to check the code first.
- **On live** (2026-10-20, the user's account with one profile, `SINAG_NUVIO_LIVE_WRITES=1 go test -run TestLiveProfiles ./internal/nuvio/`): an empty patch answered in 358 ms, so the call exists there. A rename and back, then a push of the full list plus a new profile 2 (369 ms) and deleting it, left profile 1 exactly as before, every field. Live's rows have two more fields, `profile_background_id` and `profile_background_url` (hosted only, null here). A push doesn't send them, and neither does Nuvio's dashboard, so the test refuses to write when either is set.
- **The server doesn't protect any profile.** It deleted the primary (index 1), and then the last profile left. Nuvio's dashboard refuses to delete the primary, since secondary profiles can share its addons and plugins, and Sinag does the same.

**Payload shapes we pushed** (all times in ms since epoch, positions and durations in ms):

```jsonc
// sync_push_watch_progress p_entries
[{ "content_id": "tt1254207", "content_type": "movie", "video_id": "tt1254207",
   "position": 600000, "duration": 6000000, "last_watched": 1791728748670 }]
// series: add "season": 1, "episode": 2 and video_id "<content_id>:<season>:<episode>"
```

The server builds `progress_key` itself: `content_id` for films and series-level rows, `<content_id>_s<season>e<episode>` for episodes. Delete by that key.

## Delta cursors

- **First launch:** read the cursor, then page `sync_pull_*_delta(p_since_event_id = 0, p_limit = 1000)`, each time from the last row's `event_id`, until a page has fewer than `p_limit` rows. The last `event_id` equalled the cursor on every surface, live and local.
- **After that:** pull from the stored cursor. Events are `operation = 'upsert' | 'delete'`. A delete event carries the full row as it was, so apply it by key, not by position in a list.
- **Event IDs are one global sequence across all users.** On live, our account's first event was **242,369,0xx**. Locally they started at 1. Treat a cursor as an opaque `bigint`: gaps are normal and mean nothing, and the value can't be used to count events.
- **Your own writes come back** in your delta feed. `p_origin_client_id` is set for the server's transaction but is **not returned in delta rows**, so #28 can't filter its own echo by origin. Applying events must be idempotent: compare to local state, and ignore an upsert that matches what we already have.
- **No push channel was confirmed.** The schema has an internal `emit_sync_invalidation` hook, but no client-facing realtime subscription was found. Plan to poll cursors (cheap: one call per surface) on focus and on an interval.

## Errors a client has to handle

Same codes on live and local unless noted.

| Case | Result |
|---|---|
| Sync call with no session | `42501 permission denied for function …` (live, local), or `28000 Unauthorized: valid session required for sync.` (live for `sync_pull_library`; local in an earlier run). HTTP 401 / 403. **Treat both codes as "sign in again".** |
| Expired or forged JWT | HTTP 401, `PGRST301` |
| Wrong password | HTTP 400, `invalid_credentials` |
| Unknown function, or wrong argument name | `PGRST202 Could not find the function …` (PostgREST matches on argument *names*) |
| Wrong argument type | `22P02 invalid input syntax for type integer` |
| Profile index outside 1–6 | `P0001 Invalid profile id` |
| Poll an unknown TV code | `P0001 Invalid TV login session` |
| Approve an unknown TV code | No error: an `ok` row `{success, message}`. Check `success`, not the HTTP status. |
| Too many requests | HTTP 429, `x-sb-error-code: over_request_rate_limit` (sign-in), **no `Retry-After`** |

## Rate limits

- **Live (headers only, no flooding):** Kong rate-limits per second. Data calls: `x-ratelimit-limit-second: 900`. Auth: `10`. `ratelimit-reset: 1`.
- **The 900/s budget appears to be shared.** Across ~40 sequential requests from us, `ratelimit-remaining` jumped around between 427 and 895 within the same second. Our own traffic can't explain that, so other clients are drawing from the same budget, probably because everyone sends the same public key. At Nuvio's peak this could mean 429s that aren't our fault.
- **Local (flooded):** 30 wrong-password sign-ins, then 429 on every one after. 170 calls each to `health_ping` and `start_tv_login_session` never hit a limit.
- **#28:** back off exponentially with jitter on 429, since there's no `Retry-After`. Keep sync to a few calls per surface, and never poll faster than `poll_interval_seconds` during QR login.

## Gotchas for #28

1. **Progress pushes inside the server's thresholds are silently dropped.** An update is applied only if the position moved **≥ 15 s** *or* `last_watched` is **≥ 30 s** newer than what's stored. Otherwise the call still returns 200 and nothing changes ([`local-push-throttle.json`](../../spikes/nuvio-backend/results/local-push-throttle.json)). So: push on pause / stop / seek and about every 30 s while playing, always with a fresh `last_watched`, and never treat a 200 as "stored".
2. **≥ 90 % of an item of ≥ 60 s creates a watched item** server-side (with its own 60 s update interval). The player must not also push a duplicate watched item, and must expect the watched feed to change after a progress push.
3. **`sync_push_addons` / `sync_push_plugins` replace the whole list.** An empty array deletes every addon on that profile. Always push the full, current list. Never push a partial list from a stale cache.
4. **Profiles are addressed by index (1–6), not UUID.** Profiles with `uses_primary_addons` / `uses_primary_plugins` = true presumably share profile 1's lists. Only one profile existed here, so that's unverified. New profiles with it false get Cinemeta + OpenSubtitles server-side.
5. **Overloaded functions.** Most pushes exist with and without `p_origin_client_id`, and PostgREST picks by argument names. Always send every argument, including the origin client ID, or the wrong overload is matched (or `PGRST202`).
6. **Access tokens last 7 days on live.** Supabase Auth rotates refresh tokens on use. Store the session in the OS keychain and refresh from one place only: two parallel refreshes with the same refresh token risk signing the user out. Refresh wasn't exercised in this spike. **Exercised in #22 ([ADR-0009](../adr/0009-session-lifecycle.md)):** refresh rotates both tokens. On live, a second refresh with the token just rotated gets the same new session, even 8 minutes later, rather than signing the user out, so the risk is smaller than feared; Sinag still refreshes from one place. After a sign-out (`logout?scope=local`) the refresh token gets `refresh_token_not_found`. On self-host, a token two rotations old gets `refresh_token_already_used` after the 120 s reuse interval, while the newest keeps working. A 10-minute run against self-host with 2-minute tokens (`TestLongSession`) kept every call working across 9 refreshes, and a global sign-out from another device ended Sinag's session at its next refresh (`refresh_token_not_found`).
7. **We show up in the user's session list.** Call `register_current_session` with a clear name ("Sinag on macOS"), so users can recognise and revoke us. **No longer possible (#20):** Nuvio now rejects client names other than its own apps' (`22023 Unsupported Nuvio client`), so Sinag doesn't register ([ADR-0008](../adr/0008-nuvio-client-in-go.md)).

## Inputs for #33 (contract tests)

- Run `NuvioMedia/self-host` (pinned commit) in Docker in CI. It's the same stack as live, as far as this spike could tell, and its `signup` allows throwaway accounts.
- Contract cases straight from this doc: full and delta pull with paging; the cursor equals the last event; echo of our own writes; the throttle table in gotcha 1; the 90 % watched rule; addon replace-all; every error row above; QR start → approve (second account) → poll → exchange.
- A small, manual live check per release (sign in, catalog, one push + delete) to catch drift between self-host and live. The probe's commands do exactly that.

## Open risks / not covered

- **No written permission from Nuvio.** The backend is open and the key is published for clients, but a third-party client on their hosted service is their call. Its shared rate-limit budget makes this matter more. Raise it with Nuvio before a public release (#8).
- **Live / self-host drift.** The anon error code already differs between them (`28000` vs `42501`). Nuvio can change live without changing self-host. Contract tests against self-host won't catch that, so the per-release live check does.
- **Not done on live, by design:** the throttle test (it would create a watched item on a real account), flooding, and library / watched / addon writes. Their behaviour comes from the schema and the local stack.
- **Token refresh and long-lived sessions** weren't exercised beyond the first sign-in (done in #22; see gotcha 6). Profile PINs, provider credentials and trackers were out of scope.
- **Desktop settings platform.** No `desktop` rows exist. Whether to read `tv` or another platform's settings is a product decision for #28.

## Reproduce

```sh
cd spikes/nuvio-backend && npm install
# .env (git-ignored): NUVIO_EMAIL, NUVIO_PASSWORD (quote values containing '#'); NUVIO_URL for a local stack
node src/probe.ts discover
node src/probe.ts signin            # or: tv-login, then scan with the Nuvio app
node src/probe.ts catalog
node src/probe.ts pull
node src/probe.ts push-progress tt1254207 movie && node src/probe.ts delete-progress tt1254207
node src/probe.ts errors
# local stack only:
node src/probe.ts push-throttle <id>
node src/probe.ts ratelimit 170
node src/probe.ts profiles          # #95: adds, edits and deletes profiles on a throwaway account
```
