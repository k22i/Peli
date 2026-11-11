---
name: search-page
description: "How Peli's Search (#44) is built: searchCatalogs + one searchQuery per catalog, searchGroups merge, ⌘F and / shortcut, Row keeps focus by key, fail-closed kids visibility; read before #45, #46, #96"
metadata:
  type: project
---

Search (#44, ADR-0028) is `components/search/search-page.tsx` on `/search` (`?q=`, written with `replace`). The rules are in `lib/search.ts`: `searchCatalogs` (catalogsAccepting ["search"] + `shown`), `searchTerm` (2+ characters), `searchGroups` (addon order, de-duplicated by id, Movies/Shows/Anime then others, anime catalogs → Anime). Each catalog is its own `searchQuery` (in memory only, no retry), so results stream in.

**Why:** the ticket asks for results as each addon answers. The user approved addon order over arrival order, ⌘F plus /, and grouping anime by catalog.

**How to apply:**
- `useBrowsableAddons().shown` now fails closed (`catalogVisibilityQuery`, formerly `hiddenCatalogsQuery`): wait for `loading` before asking anything for a kids profile. The hook no longer returns `hidden`.
- `Row` keeps its active card by key when items change, so streamed or reordered items don't move focus.
- The shell's Ctrl/⌘+F and / shortcut focuses `#search-field` (`searchFieldId`). After a keyboard navigation the shell no longer focuses `#content` if the page already took focus.
- Tests: `routes/search.test.tsx`'s `serve()` takes a promise per URL (`later()`) to hold an addon back. Search URLs are `…/catalog/<type>/<id>/search=<q>.json`.
- Related: [[browse-pages]], [[home-page]], [[kids-profiles]], [[virtualized-rows]].
