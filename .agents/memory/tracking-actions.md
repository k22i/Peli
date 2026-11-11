---
name: tracking-actions
description: "Lists, ratings and watchlist for SIMKL + AniList: tracking.Service SetStatus/SetRating/TitleStatus/Watchlist, outbox ops, lib/tracking.ts helpers, gotchas"
metadata:
  type: project
---

Per-profile list status, ratings and a watchlist on top of [[tracking-integrations]] (no UI yet; another task builds menu items, title controls and a Watchlist view).

**Go API** (`internal/tracking/actions.go`, methods on the existing `tracking.Service`, so no main.go change):
- `SetStatus(profileID, TitleRef, status)` / `SetRating(profileID, TitleRef, 0–10)` → `TitleTracking{status, rating, services, queued}`. Statuses: `planned watching completed paused dropped none`. SIMKL: plantowatch/watching/completed/hold/dropped via `/sync/add-to-list`; AniList: PLANNING/CURRENT/COMPLETED/PAUSED/DROPPED. Ratings: SIMKL `/sync/ratings` (+ `/remove` for 0); AniList `scoreRaw` = rating×10 (0 clears).
- `TitleStatus(profileID, ref)` reads SIMKL `/sync/all-items/<kind>` (extended=full, 5-minute per-profile copy in `Service.lists`, dropped on any write) and AniList `Media.mediaListEntry`. No connection or unknown title → status `none`, no error; fails only when every service asked failed.
- `Watchlist(profileID)` → `[]WatchlistItem` (SIMKL plantowatch movies/shows/anime + AniList PLANNING, deduped by shared ids). `ID` is IMDb's, else `kitsu:N`, else `tmdb:/mal:/anilist:…`; type is `movie`/`series`.
- `TitleRef{type,id,name,year,ids}` is the player's `Watching` fields; ids come from the same `ids()` mapping. SIMKL kind: anime-native ids → `anime`, movie → `movies`, else `shows`. AniList needs `isAnime` and a `aniListJob` match (title as a whole = season 1 of the anime list).
- Errors: `kids_profile` (`guardKids` = `canConnect`, on every method), `not_connected`, new `not_trackable` (no id either service knows, or SIMKL film as watching/paused), plus the existing unreachable/unavailable/rate_limited/refused codes. Bad status/rating gives an uncoded error.
- Outbox: `simklJob`/`aniListJob` got an `Op` (`status remove rate unrate`; empty = a watch). A temporary failure queues the job and returns `queued: true` with no error; `sendSimkl`/`sendAniList` dispatch on Op.

**Frontend** (`lib/tracking.ts`): `trackingStatuses`/`trackingStatusLabels`, `statusesFor(connections, type)` / `servicesFor` / `connectedServices` (what each service keeps; SIMKL has no watching/on-hold film), `titleRef(target, name, meta)`, `titleTrackingQuery`, `watchlistQuery`, `useSetTrackingStatus`/`useSetTrackingRating` (optimistic, roll back on error, mark the watchlist stale), `trackingActionProblem`. Keys sit under `["tracking", profileId, …]`, so `tracking:changed` (emitted after every write) refreshes them.

**Gotchas:**
- SIMKL has no "remove from list" call: `none` uses `/sync/history/remove`, which also clears the watched history for that title. A UI should confirm it. Not verified against the live API; nor is `anime` as a key of `/sync/add-to-list` (copied from /sync/history), nor `poster` → `simkl.in/posters/<id>_m.webp`.
- AniList `SaveMediaListEntry` with only a score on a title not on the list creates an entry (AniList picks the status).
- `simkltest` records `Posts` (`Writes(path)`); `Library` is keyed `"kind"` or `"kind/list"`. The AniList fake in tracking_test.go now keeps entries with ids and scores.
- `SetKids` needs a PIN-enabled Nuvio profile: the tracking test fixture creates its profile with `PinEnabled: true`.
- Pre-existing failures on main when this was built: `go test ./internal/store ./internal/plugins`, `pnpm check` (ProfileSettings fixtures missing `subtitleStyle`/`animePosterAddon`), and ~69 vitest tests in route/ranking files.
