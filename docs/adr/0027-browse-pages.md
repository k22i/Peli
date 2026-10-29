---
status: accepted
date: 2026-10-29
---

# Browse pages: one catalog at a time, filters from its own extras, anime by type and addon

#43 builds Movies, Shows and Anime (F9): a page per kind that combines the profile's catalogs of that kind, with genre and year filters taken from each catalog's declared extras and infinite scroll using `skip`. The pages share one component (`components/browse/browse-page.tsx`) and the pure rules in `lib/browse.ts`.

## One catalog at a time

Each page lists its catalogs as chips, in addon order, and shows the chosen one (the first, by default) in the virtualized `PosterGrid` (ADR-0025). We considered merging every catalog into one grid and rejected it:

- Catalogs of one addon overlap heavily (Cinemeta's Popular and Featured), so a merged grid is mostly repeats in an order that means nothing.
- Each catalog pages on its own `skip`. A merged grid needs a cursor per catalog and an interleaving rule, and a slow addon holds the rest back.
- Stremio's and Nuvio's apps both pick one catalog, so people coming from them know the model.

A page offers the catalogs that can be asked with nothing but a genre: no required extra other than a `genre` with options. That leaves out search catalogs (#44), Cinemeta's calendar and "last videos" catalogs, and Kitsu's search-only list. Addons that need configuring first answer nothing (as in `serves`). A chip reads the catalog's name. On Anime, a catalog not typed `anime` adds its type ("Popular · Shows"), and when two chips would still read the same, the addon's name is added too.

## Filters come from the catalog

The only filter is the selected catalog's `genre` extra, with its options in the addon's order:

- If every option is a four-digit year, it's labelled **Year**. Cinemeta has no year extra: its "New" catalogs list years as the genre, and require one, so they open on the newest year.
- Otherwise it's **Genre**, with "All genres" when the extra isn't required.
- A catalog with no `genre` extra (Kitsu Trending) has no filter. We don't build a year filter out of release dates in the results: it would only filter the pages already loaded.

The protocol sends one `genre` per request (`optionsLimit` defaults to 1), so genre and year can't be combined on Cinemeta.

## Infinite scroll

`catalogPagesQuery` (`lib/addon-protocol/queries.ts`) is an infinite query over one catalog and genre:

- **Page 0 is `catalogQuery`'s,** fetched through the query client, so it shares Home's persisted cache. The grid paints from that cache at once (`initialData`), and a stale page refreshes behind it.
- **Later pages send `skip` = the number of items loaded so far,** as Stremio's apps do. They're not persisted.
- **Paging stops** at an empty page or `hasMore: false`, and never starts for a catalog that doesn't declare `skip`.
- Items are de-duplicated by id: Cinemeta repeats titles across pages.

`PosterGrid` takes an `onEndReached` callback. It fires when the last mounted row is within three rows of the end, and again when new items arrive while the end is still near, so a short first page fills the screen. A spinner shows under the grid while a page loads; a failed page offers a retry and keeps what's shown.

## Anime classification

A catalog is anime's when:

1. its type is `anime` (Kitsu's catalogs), or
2. its addon's `catalog` resource answers only anime ids: every id prefix is `kitsu`, `mal`, `anilist` or `anidb`, with or without a separator (`mal:`, `mal_`). This catches anime addons that type their catalogs `series` or `movie`.

Anime catalogs show only on Anime, so an anime addon's `series` catalogs don't fill Shows. Classification goes by catalog and addon only: Cinemeta's "Animation" genre stays a genre of Movies and Shows, and a general addon with an anime-only catalog under a general id prefix stays where its type puts it.

## State, kids and the rest

- The catalog (as `catalogRef`) and genre are the route's search params, written with `replace`, so Back from a title page (#45) returns to the same view without walking back through filter changes. A catalog or genre that no longer exists falls back to the first catalog, or to "all" (or the newest year).
- Kids profiles see only `CatalogVisible` catalogs, through the same `useBrowsableAddons` hook as Home (moved to `lib/home.ts` for both).
- The layout's "hide unreleased content" applies to the grid as on Home.
- With no addons, the page shows `NoAddons` (#39). With addons but no catalogs of its kind, it says so and links to the addon manager.
- Opening a title is the title page's (#45). Opening a collection folder, which ADR-0022 left to #43, merges several catalogs into one view and is #96.

## Verification

Unit tests cover classification, filters and labels against the Cinemeta and Kitsu manifest fixtures (`lib/browse.test.ts`). Route tests cover the pages end to end (`routes/browse.test.tsx`): catalog chips, genre and year filters, the address restoring a view, paging with `skip` until an empty page, no paging without `skip`, painting from Home's cache offline, kids, hide unreleased, a failed catalog and the empty states. Against the live Cinemeta and Kitsu addons, in Playwright's WebKit with stubbed bindings, scrolling the Sci-Fi movies grid loaded pages until 148 items.
