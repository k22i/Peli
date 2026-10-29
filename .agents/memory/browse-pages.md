---
name: browse-pages
description: "How Sinag's Movies/Shows/Anime pages (#43) are built: catalog chips, genre/year filter, catalogPagesQuery paging, anime rule, test gotchas; read before #44–#46, #96"
metadata:
  type: project
---

Browse (#43, ADR-0027) is one `BrowsePage` (`components/browse/browse-page.tsx`) used by `routes/movies|shows|anime.tsx`, plus pure rules in `lib/browse.ts` (`browseCatalogs`, `isAnimeCatalog`, `catalogFilter`, `canPage`, `browseSearch`). It shows one catalog at a time, picked from chips; the filter is the catalog's `genre` extra (labelled Year when every option is a year).

**Why:** the user approved a picker over a merged grid. Merging repeats titles and breaks `skip` paging. Collection folders (the merged case) are #96.

**How to apply:**
- Paging: `catalogPagesQuery` (infinite; page 0 goes through `catalogQuery` so it shares Home's persisted cache, later pages `skip` = items so far) + `PosterGrid`'s `onEndReached`. Reuse both for #96 and Library.
- Addons for any browsing surface: `useBrowsableAddons(profileId)` in `lib/home.ts` (visible addons + manifests + kids `shown`), shared with Home.
- Search params `{catalog: catalogRef, genre}` are written with `replace`. The router parses a bare year as a number; `browseSearch` turns it back into a string.
- Tests: `src/test/setup.ts` now forces `#content`'s computed `overflowY` to auto (jsdom doesn't expand Base UI's inline `overflow: scroll`), so a `PosterGrid` inside the real shell mounts cards. Cards still mount a tick later: use `findAllByRole`. `routes/browse.test.tsx`'s `serve()` keys by full URL for several addons.
- Stubbed WebKit screenshots: the #42 Playwright harness + stubs (copy `pw/` and `stubs/` from an old scratchpad; add Kitsu to the store stub's addons) against `vp dev --config vite.stub.config.ts` on port 9398; live Cinemeta/Kitsu answer CORS fine.
- Related: [[home-page]], [[virtualized-rows]], [[addon-protocol-client]], [[kids-profiles]].
