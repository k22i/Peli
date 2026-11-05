---
name: anime-from-anilist
description: "Epic #106 layout: sinag:// built-in addons kept out of Nuvio sync (#107), internal/anilistaddon (#108), anime left out of Movies/Shows via animelist.IMDbIDs (#109); gotchas"
metadata:
  type: project
---

Epic #106 (ADR-0045), built 2026-11-05: the Anime tab is filled by Sinag's own AniList addon, and anime with IMDb ids is left out of Movies and Shows.

**Why:** the user wants AniList preferred over Kitsu for lists and details, and chose an addon over a built-in catalog source ("not sure yet how to feel about" a non-addon source). Stream addons only take `kitsu:`/`tt` ids, so items carry the mapped Kitsu id; unmapped ones keep `anilist:` and show "No streams yet" (user's choice).

**How to apply:**
- Built-in addons (#107): URL `sinag://<name>/manifest.json`; `addons.Service.Register(name, http.Handler)` answers them in `Fetch`; the TS client sends `sinag://` straight to `fetchViaGo` (`isBuiltinAddon`). `store/builtins.go`: `SyncedAddons` (backend push strips list and base), `keepBuiltins` (pull keeps them in place), `offerBuiltins` (before the first URL containing "kitsu", else last; `builtins-offered` key so removal sticks). Offering only happens after `Store.UseBuiltins(Builtins)` (store.Service startup), so test stores get none and old tests' exact addon lists still hold.
- AniList addon (#108): `internal/anilistaddon` (catalog.go lists/ids, meta.go details + Kitsu `kitsu.app/api/edge` episodes), `anilist.Client.Public` for token-less queries, `animelist.List` shared with tracking in main.go and warmed at startup. In-memory cache (30 min lists, 6 h meta), x/time/rate limiter, 503 while AniList's Retry-After runs.
- Leaving anime out (#109): `animelist.Service.IMDbIDs` → `animeIdsQuery`/`useLeaveOutAnime` (`lib/anime.ts`); applied in browse `CatalogGrid` (asks the next page itself when a page adds nothing, up to 20), Home rows/hero (not anime catalogs), `searchGroups(answers, leaveOut)`. Setting `animeInMoviesAndShows` in Settings › Addons. `src/test/setup.ts` mocks `@bindings/animelist` globally (none are anime); override with `vi.mocked(AnimeList.IMDbIDs)`.
- New ProfileSettings fields must be added to the test fixtures in `lib/player.test.ts`, `routes/player.test.tsx` and `routes/settings.test.tsx`, or `vp check` fails.
- `go build .` drops a `sinag` binary in the repo root; delete it.
- Related: [[browse-pages]], [[addon-protocol-client]], [[sync-module]], [[tracking-integrations]], [[search-page]].
