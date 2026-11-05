---
name: library-redesign
description: "#118 Library/Upcoming redesign: LibraryFrame on Browse's exported BrowseFrame, Tabs-on-glass-thin view switch, episodeLabels card meta, sticky day headers (offset, z-order), airTime, LibraryNotice, screenshot rig"
metadata:
  type: project
---

#118 (redesign epic [[redesign-epic]]) gave `components/library/library-page.tsx` the sticky glass header of Browse: `BrowseFrame` (now `export`ed from `components/browse/browse-page.tsx`, unchanged) with the view switch in its `filter` slot and, on Titles, the type `ChipRail` + Sort `Select` in its `rail` slot. `LibraryPage` → `Library` (one component for both views, so the header stays mounted when the switch changes) → `LibraryFrame`. The switch is coss `Tabs` (roles, `?view=`, tab names kept) inside a `glass-thin rounded-full p-1` wrapper span, with a bare `TabsList` (`bg-transparent p-0`) and the indicator restyled with `*:data-[slot=tab-indicator]:…` (`bg-background shadow-card rounded-full`). `components/library/notice.tsx` is `LibraryNotice` (Browse's Notice with a `size-16` icon; actions are plain `buttonVariants()` = solid). Cards' meta is `libraryMeta(item, episodeLabels(progress).get(id))` (lib/library.ts); the progress is `continueWatchingQuery`, so only shows in Continue Watching get "S2 · E5". Upcoming: `DaySection` has a sticky `glass` h2 in a `scroll-edge-top` wrapper, rows are `w-24` posters, `p-3 gap-5 rounded-2xl`, the end shows `airTime(entry)` (lib/calendar.ts) or, in Later, `airDate`.

**Why:** the user's Apple Music-style Library; the ticket asked to reuse #116's header rather than copy it.

**How to apply:**
- Day headers: `top = --titlebar-h + 4.375rem` (the stuck header is 3.375rem: py-2 around the 38px switch, one row on Upcoming) and `z-9` under the page header (`z-10`), so a header pushed out slides beneath it; the extra 1rem keeps the page header's 24px scroll-edge from veiling the day header. If the switch's height or the header's padding changes, retune `stuckHeader` in `upcoming.tsx`. The day headers are always glass (no stuck detection), full column width.
- `airTime` is nothing when `airs % 86_400_000 === 0` (a date, i.e. midnight UTC); Cinemeta mostly gives dates, so most rows have no time. Don't invent one.
- The context menu popup takes `className="glass"` at the call site; index.css maps only `menu-popup`, not `context-menu-popup` (#122 may add it).
- A tier sets its own background: the switch's pill is a wrapper because `TabsList` carries `bg-muted`, and twMerge doesn't know `glass-thin`.
- Contrast pairs added: "Library view switch, idle tab" (+ in the stuck header), "Day header label" over page/black/white (dark over white is 4.54, the tightest).
- Tests weren't run (the user asked to skip them): `library.test.tsx` (new ContinueWatching mock, "S5 · E3" card test, air-time test), `library.test.ts` (libraryMeta, episodeLabels), `calendar.test.ts` (airTime), `contrast.test.ts`. Not pushed (Actions down).
- Screenshot rig as in [[app-shell]]: stubs in the scratchpad, plus a node addon server on :5918 (Cinemeta manifest, generated `videos` dated from today, real Metahub posters); the `addons.Fetch` stub must return a promise with `.cancel` and the server must stay up (a dead one shows "Couldn't check N shows"). Don't use `pnpm exec vp` in a symlinked worktree; call `node_modules/.bin/vp`.
- Related: [[library-page]], [[upcoming-episodes]], [[chip-rail]], [[glass-materials]].
