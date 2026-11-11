---
name: discovery
description: "Search filters (kind/decade/genre in the URL), per-profile recent searches, TMDB People row, Home's New episodes row and Surprise me; files, rules and test gotchas"
metadata:
  type: project
---

**Search** (`components/search/search-page.tsx`, `lib/search.ts`): `SearchPage` renders the field at once, before the profile loads (keeps focus, tests find it synchronously); `useSearchResults` (catalogs + one `searchQuery` each + `searchGroups`) is called by both `SearchFilters` and `FoundResults` (the query cache shares the requests). `?type=movie|series|anime`, `?year=2020|2010|2000|1990|older` (decade; a title with no year drops out), `?genre=` (case-insensitive, options from the results via `searchGenres`). `searchSearch` validates, `changeSearch(search, changes)` edits, `filterGroups` applies; the addon-order merge in `searchGroups` is untouched. Filters sit under the field (`ChipRail` + two coss Selects) and only show once there are results. Typing a new query keeps the filters; clearing the field drops them.

**Recent searches** (`lib/recent-searches.ts`, `internal/store/recent.go`): kept in the Go store per profile (`recent-searches` key in the profile bucket, local, not synced; `Store`/`Service.RecentSearches` + `SetRecentSearches`, max 8, no blanks). Webview storage is the theme's only (`storage.test.ts`), so never `localStorage` here. `useRecentSearches(profileId | undefined)` reads `recentSearchesQuery` and saves optimistically (`withRecent`: 8 newest first, case-insensitive dedupe; `withoutRecent`). Added on Enter and when a result is opened (not on debounce). Shown under the empty field with remove buttons and Clear all. The field notices a `q` it didn't write (a picked recent search) and takes it as its text (`written` ref). Test mocks need `RecentSearches`/`SetRecentSearches` (route tests that render Search).

**People** (`lib/tmdb-person.ts`: `parseTmdbPeople`, `useTmdbPeople`): TMDB `/search/person` (kept in memory 5 min), a "People" row of PosterCards (photo, name, known-for titles) opening `/person/$id`. Not asked at all without a key, on kids profiles, or while any filter is on (people can't be filtered by kind/year/genre).

**Home** (`components/home/home-extras.tsx`, `routes/index.tsx`): `NewEpisodes` after Continue Watching uses `recentEpisodes` in `lib/calendar.ts` (each library show's latest episode aired within 7 days, newest first, no specials, same-time episodes on one card; shows' details from `titleMetaQuery` + `cachedTitleMeta` like Upcoming). No row when none. `SurpriseButton` is a hero action (CatalogHero and WatchingHero take a `surprise` node): `lib/surprise.ts` reads Library + `allWatchedQuery` (`Store.Watched`, key under `["watched", id, "all"]`) fresh on click, picks a random library title with no watched mark of any kind (a started show isn't a surprise), else a random unwatched item from the first catalog row; nothing → info toast.

**Why:** the ticket asked for these four discovery pieces; kids keep fail-closed behaviour (People never asked, library/catalog data already goes through visible addons).

**How to apply / gotchas:**
- Tests live in `routes/discover.test.tsx` and `lib/discover.test.ts`. Route tests there raise `asyncUtilTimeout` (cold route chunks on a busy machine) and use `findBy*`, not sync `getBy*` right after `renderApp`.
- Pre-existing: 8 of `routes/search.test.tsx`'s tests fail on this branch before these changes (sync `getByRole("searchbox")` right after render; region lookups). I only added a `Library` stub to its store mock. Full `pnpm test` also fails ~55 tests elsewhere, and the machine's load makes timing worse.
- Related: [[search-page]], [[search-folder-layouts]], [[upcoming-episodes]], [[home-page]], [[person-pages]], [[kids-profiles]].
