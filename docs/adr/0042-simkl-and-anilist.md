---
status: accepted
date: 2026-10-31
---

# SIMKL and AniList: connected per profile from Go, scrobbles from the player's reports, imports that only add

Epic #71 tracks with SIMKL (#72–#74) and AniList (#104, #105); Trakt and Discord are out. Everything is in Go: `internal/simkl` and `internal/anilist` are the wire clients, `internal/animelist` maps anime ids, and `internal/tracking` is the Wails service Settings calls and the scrobbler the player reports to. The webview never sees a token.

## Per profile, tokens in the keychain

A connection belongs to a profile, like its addons. Tokens are keychain items per profile (`simkl.access-token.<id>`, `simkl.refresh-token.<id>`, `anilist.access-token.<id>`, ADR-0007); the store keeps the account name, expiry and import bookkeeping in the profile's `tracking` record, so it goes when the profile does. A device-level list of profiles that were given tokens lets startup remove what a deleted profile left in the keychain. Kids profiles connect to neither (`ErrKidsProfile`).

The apps Sinag is registered as are public: a desktop app can't keep a secret, and neither flow needs one. The client ids are constants in `internal/tracking` (`$SINAG_SIMKL_CLIENT_ID` and `$SINAG_ANILIST_CLIENT_ID` override them); with none, Settings says the service isn't available in this build.

## SIMKL sign-in: AUTH V2's device flow

SIMKL retires AUTH V1 around April 2027, so Sinag starts on V2. The device flow (RFC 8628) needs no redirect and no secret: Settings shows the code, opens `verification_uri_complete` in the browser with it filled in, and Go polls every 5 s (5 s more on `slow_down`) until the user allows it or the code runs out after 15 minutes. SIMKL never says no, so the expiry is what ends a refused sign-in. The grant must have `media:write` (SIMKL downgrades an unknown scope to read-only without saying so); a read-only one is revoked and refused.

Access tokens last 7 days and refresh tokens 180 days, sliding. Go is the grant's one owner: it refreshes a day before expiry or on a 401, one refresh at a time, and if another refresh already replaced the refused token it uses that one. When refreshing fails the row asks to reconnect. Disconnecting revokes the grant (best effort) and forgets the tokens and queued jobs.

## AniList sign-in: implicit grant to a loopback page

AniList's authorization code grant needs the app's secret, and an app has one redirect URL. Sinag uses the implicit grant redirected to `http://127.0.0.1:47613/anilist`, a page Sinag serves only while a sign-in is pending (10 minutes). The token comes in the URL's fragment, which only the page's script can read; it posts it back to the same origin and clears it from the address bar. The pin page (paste the token) was the alternative, but AniList's tokens are JWTs of about a thousand characters. A fixed port can be taken, which Settings explains. Tokens last a year and don't refresh: the expiry is read from the JWT, and an expired or refused token asks to reconnect. AniList has no revoke call.

## Scrobbling (#73): one call per thing the user does

The player reports why it reports. #73 adds `started` (first frame) and `resumed` (playing after a pause) to #64's `playing`, `paused`, `seeked`, `ended` and `stopped`; `internal/watching` pushes on neither. `main.go` fans each report out to `watching` and `tracking`. The scrobbler maps them as SIMKL asks: start on `started` and `resumed`, pause on `paused`, stop on `ended` and `stopped`, and nothing on seeks or periodic reports, since SIMKL extrapolates and warns against heartbeats. A periodic report while it believes the file paused means a resume it missed, and sends a start. Calls run one at a time on the scrobbler's goroutine; the player never waits on the network. The service is listed before the player, so it shuts down after it and sends the last stop (up to 5 s).

**SIMKL and Nuvio agree on 90 %.** SIMKL marks a stop at 80 % watched; Nuvio's rule is 90 % (#45). Every call sends `min_progress=90`, so a stop marks it watched on SIMKL at the same point Sinag and Nuvio do. Holding the stop back ourselves would have lost SIMKL's resume points below 90 %.

**Ids.** The frontend adds the meta's ids (`imdb_id`, `moviedb_id`, `tvdb_id`, `kitsu_id`, `mal_id`, `anilist_id`, `anidb_id`), the title's name and year to `Watching`; Go adds the content id's own and drops malformed ones. Films go as `movie`, series as `show` with season and number. A title whose content id is an anime catalog's (`kitsu:`, `mal:`, `anilist:`, `anidb:`) goes as `anime` with only those ids and the plain episode number: SIMKL tries ids in a fixed order, and an IMDb id would name the whole series while the number counts within the cour.

**Settings.** Scrobble, import and include anime are per profile (`ProfileSettings`), on by default. With anime off, anything with an anime id, or an IMDb id the anime list knows, isn't scrobbled or imported.

**Offline.** A start or pause only says what plays now, so a failed one is dropped. A stop at 90 % or more that fails because SIMKL is unreachable, down or rate limiting is kept in the profile's `tracking-outbox` and sent later to `/sync/history` with the time it was watched (`use_tvdb_anime_seasons` for shows, which SIMKL otherwise reads as AniDB's numbering when it keeps the show as anime). Backoff is 30 s doubling to an hour, or SIMKL's `Retry-After` when longer; a job is dropped after 30 days or on a lasting error. A 409 on a stop is SIMKL having finalized that session already, so it counts as done. A 404 (`id_err`) is logged and dropped.

## AniList progress (#105)

AniList has no playback. When a report shows Nuvio's watched point (90 % of at least a minute), once per file, the entry's progress becomes that episode: Completed at its last episode or for a film, Current before, Repeating kept. An entry already as far isn't touched, so an earlier episode never moves the list back. Failures queue like SIMKL's.

**Mapping** (`internal/animelist`): an `anilist` id as it is; Kitsu and MyAnimeList ids through the list, else MyAnimeList through AniList's own `Media(idMal:)`; an IMDb id with Cinemeta's season through the list's TVDB season and episode offset, picking the cour whose offset is the largest still before the episode. The list is [Fribb/anime-lists](https://github.com/Fribb/anime-lists)' `anime-list-mini.json` (about 6 MB, 20,000 AniList entries), downloaded on first use to the data directory and again weekly; a failed download keeps the copy and tries again after an hour. It isn't bundled, so its licence (none stated) doesn't reach the app. Without it and offline, only `anilist` and MyAnimeList ids map.

## Imports (#74, #105): watched wins, imports only add

SIMKL's history and the AniList list become watched marks through `Store.ImportWatched`, which queues them for Nuvio like any other mark. The precedence rules:

- **An import only adds.** A mark is never removed by an import, on either side, and Sinag's removals don't reach SIMKL or AniList. A title unmarked here can come back if it changes on the tracker later.
- **A mark already here keeps its time.**
- **Progress newer than the imported watch is kept**, so a rewatch under way isn't cleared; older progress is, as marking watched does (#45).
- **Anime marks go to the Kitsu id** when the list has one, which the anime addons use, and to the IMDb id with TVDB numbering otherwise. SIMKL's anime episodes are numbered within the entry (with `full_anime_seasons` saying where each falls in TVDB's), so both are known.

SIMKL's import follows its two-phase sync: `/sync/activities` first, then only the types whose time moved, with `date_from` set to the last import's `all` (none on the first, which pulls everything with `extended=full&episode_watched_at=yes&include_all_episodes=yes`). The new time is saved only if every pull succeeded. `removed_from_list` is ignored, since imports never remove. AniList has no activity times: the whole list is one query, and only entries updated after the last import are read.

Imports run on launch, on window focus and on switching profiles (at most every 15 minutes, never on a timer, as SIMKL's rules ask), after connecting, and when Settings turns an import on. Added marks emit `tracking:imported`, which refreshes watched and progress queries.

## Not done

- Pulling SIMKL's paused playbacks into resume points (#73 leaves it out).
- Rewatches (`allow_rewatch`): SIMKL wants explicit intent and a PRO account.
- Pushing Sinag's own marks (made by hand on the title page) to SIMKL or AniList: only what plays is scrobbled.
