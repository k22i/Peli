---
status: accepted
date: 2026-10-29
---

# Library page: the whole library from the local store, sorted and filtered in the page

#46 builds the Library page (F12): a grid of the profile's saved titles with a type filter, three sorts and removal, working offline. The page is `components/library/library-page.tsx` on `/library`, with its rules in `lib/library.ts`.

## Read from the local store, all at once

The library is already in the local store (#14), kept in step with Nuvio by the pull (#29) and push (#30) loops, so the page reads `Store.Library` and needs no network. A library is small next to a catalog, so the page loads it whole and filters and sorts it in memory: no paging, and the grid is the virtualized `PosterGrid` (ADR-0025). The query is `["library", profileId]`, so a profile switch shows the new profile's library (#24) and a pull refreshes it.

Cards show the art and year saved with the item (`libraryItem`, #45). Offline, art that WebKit hasn't cached falls back to the title, as everywhere else. Opening a card goes through `useOpenTitle`, so the title page's hero paints at once.

## Filter and sort

- **Type:** chips for All, then each type in the library, in the order Movies, Shows, Anime, then any other an addon uses, by name. With one type there are no chips.
- **Sort:** a Select with **Recently added** (the default, `addedAt`), **Recently watched** and **A–Z** (`Intl.Collator`, numeric, ignoring case; a leading "The" counts).

Both live in the address (`?type=&sort=`, defaults left out), written with `replace`, as on the browse pages (ADR-0027), so Back from a title returns to the same view.

## Recently watched

A title's last-watched time is the later of its latest progress entry's `lastWatched` and its latest watched mark's `watchedAt`, over the title and all its episodes. Titles never watched go last, most recently added first.

This is a new Go call, `Store.LastWatched(profile)`, which reads both buckets in one transaction and returns content ID → time. We considered building it in the frontend from `Watched` and `ContinueWatching` and rejected it: Continue Watching leaves out finished entries, so a title finished but not (yet) marked watched would sort as never watched. The query is `["last-watched", profileId]`, refreshed by pulls of both the progress and watched surfaces (`lib/sync.ts`) and after the title page's watched edits.

## Removing

A card is a `<button>`, so it can't hold another button. Removing is in the card's context menu (right-click, coss `context-menu`), and Delete or Backspace removes the focused card. Focus then moves to the title that took its place (or the one before it at the end), so the keyboard stays in the grid. A toast offers Undo, which saves the same item back with its original `addedAt`. The title page's library toggle (#45) is the other way in.

## Not here

- **Watched badges.** A series' watched state needs its episode list from an addon (ADR-0029), which the library doesn't keep. Left for later.
- **Kids profiles** see their own library unfiltered. Nothing in the library comes from an addon they can't use until they open it, and the title page checks visibility then.

## Verification

Go: `TestLastWatched` (progress against marks, finished episodes, other profiles). Unit tests for filter, sort and the search params (`lib/library.test.ts`). Route tests (`routes/library.test.tsx`) with every fetch failing: the grid, type chips and the address, recently watched and A–Z, opening a title, removing from the context menu with Undo, Delete with focus following, the empty state and a profile switch. In Playwright's WebKit with stubbed bindings: 11 titles over four types, both sorts, removing, Undo and Delete, in dark and light.
