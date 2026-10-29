---
status: accepted
date: 2026-10-30
---

# Collection folders: a folder's catalogs taken in turn, in one grid that only grows

#96 opens a collection folder from its tile on Home (F7). A folder (ADR-0022) names several addon catalogs, so it can't reuse the browse pages' one-catalog view (ADR-0027). The page is `components/folder/folder-page.tsx` on `/folder/$collectionId/$folderId`, and its rules are in `lib/folder.ts`.

## Which sources are shown

`folderSources` matches each saved source to an addon by manifest id with `findCatalog`, as Home matches layout rows. It keeps the folder's order and passes the saved genre. A source is skipped when:

- its addon is uninstalled, turned off, or needs configuring;
- its catalog is gone from the manifest;
- a kids profile may not see it (`CatalogVisible`, through `useBrowsableAddons`). Kids profiles get no collections anyway (ADR-0022), so for them the page says the folder isn't there;
- it needs an extra other than a genre (a search catalog, for example);
- it repeats an earlier source with the same genre.

A catalog that requires a genre but was saved without one gets its first option, as on the browse pages. When nothing is left, the page says so and links to the addon manager.

## How the grid is merged

Nuvio's apps merge a folder's "All" tab round-robin: one item from each source in turn, keeping the first copy of a title (`FolderDetailRepository.rebuildAllTab` in NuvioMobile; we only read the code to learn the order). `mergeSources` does the same, with one difference. Nuvio rebuilds the whole list as each page lands, so items below the fold move. Here the grid only goes as deep as the shallowest source that may still have more, so a new page adds to the end and nothing on screen moves. A source that has run out just stops contributing. The sources at that depth (`behind`) are the ones the grid loads next.

Each source pages with browse's `catalogPagesQuery` (`skip` = items so far). `useFolderPages` keeps one `InfiniteQueryObserver` per source, since `useInfiniteQuery` can't take a list. The query keys are browse's, so a folder and a browse page showing the same catalog and genre share their pages. A first page Home already showed comes from the persisted cache. The grid waits until every source's first page has answered, which is at most one addon timeout. A source that fails outright drops out. When every source fails, there's a Try again button. If a later page fails, the grid stops and offers Try again for that source. The layout's "hide unreleased content" applies, as on browse.

## The header

The header is a shorter Hero. It shows the collection's name as the eyebrow, the folder's cover in its tile shape, and the folder's title logo or, without one, its emoji and title. Behind it is the folder's backdrop, else the collection's, else the generated gradient. Like the Hero, it is always dark, so a title logo made for dark art reads in either theme. `Hero`'s `Logo`, which falls back to the name, is now exported.

## Not here

- **Per-source tabs.** Nuvio's folder screen also has one tab per source. The ticket asks for the merged grid, and a browse page already shows a single catalog.
- **TMDB and Trakt sources.** The store keeps addon sources only (ADR-0022). Folders made of those show as having nothing to show.
- **The collection's view mode** (`viewMode`, `showAllTab`). There's one view.

## Verification

- **Unit tests** (`lib/folder.test.ts`) cover:
  - finding a folder;
  - resolving sources by manifest id with their genres;
  - the skipped cases, including a catalog that needs a genre, and an addon that needs configuring;
  - the round-robin merge with de-duplication;
  - waiting for a source;
  - the depth rule, and that a later page only appends.
- **Route tests** (`routes/folder.test.tsx`) cover:
  - opening from Home's tile;
  - the header;
  - the merged grid, with an uninstalled addon skipped and a shared title shown once;
  - the logo;
  - paging every source with `skip`;
  - a catalog a kids profile may not see, which is never asked;
  - no usable sources;
  - a folder that's gone.
- **Live check:** Playwright's WebKit with stubbed bindings and live Cinemeta and Kitsu answers, in dark and light, with and without a logo. The folder held Cinemeta's Popular movies in Drama, an uninstalled addon and Kitsu's Top Airing. Cards alternated between the two catalogs, and after scrolling 6,000 px they still alternated, so both had paged. The Breaking Bad logo read on the dark header in light mode.
