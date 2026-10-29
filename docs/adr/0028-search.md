---
status: accepted
date: 2026-10-29
---

# Search: every search catalog at once, merged in addon order as each answers

#44 builds Search (F10): the profile's addons are searched in parallel and results stream in as each addon answers. The page is `components/search/search-page.tsx` on the `/search` route, with the pure rules in `lib/search.ts`.

## What's asked

A search asks every catalog that takes `search` and needs nothing else (`catalogsAccepting(addons, ["search"])`, ADR-0023): Cinemeta's movie and series "top" catalogs and Kitsu's search list, for the default addons. Addons that must be configured first answer nothing.

- **Kids profiles** ask only what their parent allowed (ADR-0014): the addons come from `VisibleAddons` through `useBrowsableAddons`, and each catalog must pass `CatalogVisible`. The page waits for those answers before sending anything, so a disallowed addon is never asked, not merely hidden. A route test checks the fetches.
- **Typing is debounced** by 300 ms, and nothing is sent under two characters. Enter searches at once; Escape clears.
- **Each catalog is its own query** (`searchQuery` in `lib/addon-protocol/queries.ts`), keyed by catalog and query. Results stay in memory for 5 minutes and aren't written to disk. They're not retried, so a slow addon's error shows rather than doubling its wait. A new query or leaving the page cancels the old requests.
- **Only the first page** of each answer is shown. Paging a search with `skip` is left for later, if people miss it.

## Streaming

Results render as soon as any catalog answers. While others are still out, a line reads "Searching Anime Kitsu…". An addon that fails gets "Cinemeta didn't answer. Try again", and the rest stay on screen. "No results" shows only once every catalog has answered, and "Couldn't search" only when all of them failed. Against the live addons in WebKit, Cinemeta's series results showed about 1.5 s after typing began and its movie results about 0.5 s later, each when its own request answered.

## Merging and grouping

`searchGroups` merges the answers so far:

- **Addon order, not arrival order.** Results follow the user's addon order, as every other surface does (ADR-0023). A slow addon early in the order inserts its results ahead of ones already shown. To keep that from moving the user, `Row` now keeps its active card by key: focus and the Tab stop stay on the same card when items arrive ahead of it.
- **De-duplicated by id.** The first catalog to list a title keeps it. Ids are compared as sent, so Cinemeta's `tt` id and Kitsu's `kitsu:` id for the same show both appear, one under Shows and one under Anime. Matching across id systems needs metadata we don't have yet.
- **Grouped by kind:** Movies, Shows, Anime, then any other type in the order it first appears. A result from an anime catalog (`isAnimeCatalog`, ADR-0027) goes under Anime even though Kitsu types its items `series` and `movie`. Otherwise the item's own type decides.

Each group is a virtualized `Row` in a `RowGroup` (ADR-0025). The layout's "hide unreleased content" doesn't apply: someone searching for an announced title wants to find it.

## Keyboard

- **⌘F / Ctrl+F**, or **/** when focus isn't in a text field, focuses the search field from anywhere, opening Search if needed. ⌘5 still opens Search.
- The field takes focus when the page opens. The shell's "focus the content after a keyboard navigation" now leaves focus alone if the page already took it.
- **↓** from the field moves to the first result. **←/→** move along a row, **↑/↓** between rows, and **↑** from the first row returns to the field.

## State

The query is the route's `q` search param, written with `replace`, so Back from a title page (#45) returns to the results without walking back through every keystroke. As with browse's year, the router reads a bare number ("1917") as a number, and `searchSearch` turns it back into text.

## A fix for kids profiles everywhere

Writing the kids test showed that `useBrowsableAddons` let unchecked catalogs through. The visibility query keeps its last answer up while a new one loads, so when a manifest loaded after the first check, its catalogs weren't in that answer and counted as allowed. For a moment, Home and browse showed and fetched them, and Search would have searched them. The query is now `catalogVisibilityQuery`, which maps each catalog to whether it's shown. `shown` fails closed for a catalog it hasn't checked, and `loading` stays true until every catalog has an answer (ADR-0026 updated).

## Verification

- **Unit tests** (`lib/search.test.ts`) cover catalog choice, the query rules, de-duplication, order and grouping against the Cinemeta and Kitsu fixtures.
- **Route tests** (`routes/search.test.tsx`) cover:
  - the fastest addon showing while a slower one is held back;
  - one request per catalog after typing pauses;
  - the address restoring a search;
  - the kids profile never asking a disallowed addon or catalog;
  - a failed addon with a retry, and the empty states;
  - ⌘F and / from another page, and the arrow keys.
- **Row test:** focus stays on its card when items arrive ahead of it.
- **Live check:** with stubbed bindings in Playwright's WebKit, searching "dune" and "naruto" against live Cinemeta and Kitsu streamed in group by group. A Cinemeta 504 showed its retry note.
