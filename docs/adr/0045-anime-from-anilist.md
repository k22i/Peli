---
status: accepted
date: 2026-11-05
---

# Anime from AniList: a built-in addon, kept on the device, and anime out of Movies and Shows

Epic #106. The Anime tab only filled from anime addons (ADR-0027), so with Cinemeta and stream addons alone it was empty. Cinemeta's general catalogs also list anime (One Piece, Frieren) under IMDb `tt…` ids, so they filled Shows. The user wants AniList as the source for anime lists and details.

## A built-in addon, not a built-in catalog source (#107)

We considered building AniList into the browse pages as a catalog source of its own, and rejected it. It would need its own rules for order, turning off, kids profiles, Home rows, search and title pages. An addon gets all of those for free. The other option, recommending a third-party AniList addon (AIOMetadata, Anime Catalogs), leaves the ids it sends up to its configuration, and stream addons only take `kitsu:` and `tt` ids for anime.

So Peli ships its own addon:

- **Address.** A built-in addon's manifest URL is `peli://<name>/manifest.json`. `internal/addons.Fetch` answers `peli://` requests from handlers registered at startup (`Service.Register`), with the same status, size and error rules as the network. The webview's client (`lib/addon-protocol/client.ts`) sends them straight to Go.
- **In the list like any other addon.** The user can reorder it, turn it off or remove it. Kids profiles' allow-lists leave it out until the parent adds it.
- **Kept on the device.** Other devices can't reach it, so Nuvio's copy of the list never has it. A push strips built-in addons from the list and from the merge base (`store.SyncedAddons`). An edit that only touches them queues nothing. A pulled list keeps this device's built-in addons where they were (`keepBuiltins`): after the addon each followed, or before Kitsu's or last when that addon is gone.
- **Offered once per profile.** `Store.UseBuiltins(store.Builtins)` runs at startup and when a profile is created. It inserts each built-in addon before the first Kitsu addon (so AniList answers anime details first), or last, and remembers the offer (`builtins-offered`), so a removed one stays removed. A store opened without it, as in tests, offers none.
- The addon manager shows "Built into Peli · on this device only" in place of a host, and no Configure item.

## Peli's AniList addon (#108)

`internal/anilistaddon`, at `peli://anilist/manifest.json`.

- **Catalogs**, typed `anime`: Trending, This season, Next season, Popular and Top rated, each with AniList's genres (Hentai left out) and `skip` (pages of 50). A Search catalog requires `search`. Adult titles are never listed (`isAdult: false`), and music videos are left out.
- **Ids.** A title goes by the Kitsu id the anime list (`internal/animelist`, ADR-0042) maps its AniList entry to, since stream addons take those. With none, it goes by `anilist:<id>`. No stream addon serves that id, so the stream page says "No streams yet". The IMDb id isn't used: one IMDb id covers every season, while AniList has an entry per season or cour, and the IMDb id would put the title back among Cinemeta's.
- **Types.** AniList's MOVIE format is `movie`; TV, ONA, OVA and specials are `series`, as Kitsu's addon has them.
- **Details** for `kitsu:` and `anilist:` ids: the title (English, else romaji), the synopsis as text, cover, banner, genres, years, score, runtime, studios and AniList as links, and a YouTube trailer. A Kitsu id the anime list can't map answers 404, so the next addon with details (Kitsu's) answers.
- **Episodes** (`series`): numbered 1 to AniList's episode count, or to the highest episode known while it's airing. Titles, thumbnails, synopses and air dates come from Kitsu's public API (`kitsu.app/api/edge`, 20 a page, four pages at a time, up to 1,500 episodes). AniList's airing schedule gives exact air times, which win, so Upcoming (#48) lists the next episode at its time. Video ids are `<id>:<n>` with season 1, as Kitsu's addon sends them. Without Kitsu, they read "Episode N".
- **Limits.** AniList allows about 90 requests a minute (30 while degraded). The addon keeps under 85 a minute in bursts of 10, keeps lists for 30 minutes and details for 6 hours in memory, and after a 429 answers 503 until AniList's `Retry-After` has passed.

## Anime out of Movies and Shows (#109)

Classification by catalog stays as ADR-0027 has it. On top of it, titles of general catalogs that the anime list knows by IMDb id are left out of:

- the Movies and Shows pages,
- Home's general catalog rows and its hero,
- search's Movies and Shows groups.

Anime catalogs keep everything, so the AniList and Kitsu catalogs' results are untouched. Continue Watching, the library, collection folders and title pages show what the user picked, so they're not filtered.

- **Ids from Go.** `animelist.Service.IMDbIDs` gives the frontend every IMDb id on the list (`animeIdsQuery`, kept for a day). Until Go has a copy of the list (first run, offline), it says it isn't ready, nothing is left out, and it's asked again every 30 s.
- **Paging.** A page whose titles are all left out adds nothing, so the grid, which asks for more only as new items arrive, would stop. `CatalogGrid` asks for the next page itself when the last one added nothing, up to 20 pages, then waits for scrolling. This also covers pages that "hide unreleased" empties.
- **Setting.** "Show anime in Movies and Shows" (`ProfileSettings.animeInMoviesAndShows`), in Settings › Addons, off by default.
- Western animation (Arcane, Bluey) isn't on the list, so it stays where its type puts it.

## Verification

Go: `internal/addons` (built-in fetch), `internal/store` (`builtins_test.go`: offering, keeping on pull, no push for built-in edits), `internal/backend` (`TestBuiltinAddonsStayOnTheDevice` against the fake Nuvio), `internal/anilistaddon` (manifest, catalogs, details, episodes, the cache and the rate limit against a fake AniList and Kitsu), `internal/animelist` (`IMDbIDs`). Frontend: the client sends `peli://` to Go alone, `lib/anime.test.ts`, search's grouping, and the Shows grid reading past a page of only anime.
