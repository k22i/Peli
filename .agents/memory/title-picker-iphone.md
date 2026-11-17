---
name: title-picker-iphone
description: "#136 title page and stream picker on iPhone: Back lives in TopBar (BackLink), Hero title overview + More, TitleMoreMenu, season •••, compact picker header, two-line rows"
metadata:
  type: project
---

#136 (epic [[ios-polish-epic]]) made `useCompactShell()` branches in the title page and picker; desktop and the iPad full screen render as before.

**Why:** the Phase 7 screenshots showed three stacked glass circles, a 60 % hero, wrapping actions and a picker whose hero took 40 % of the screen.

**How to apply:**
- Back on `/title/*` and `/streams/*` at compact is drawn by `TopBar` (`BackLink`, left end, media glass over art, `material-pop` otherwise). It can't live in the page: the page sits in `main` (fixed, its own stacking context) under the TopBar's z-30, which would swallow the taps. `title/back-button.tsx` returns null at compact; the picker's compact `PageHeader` has no Back.
- `Hero size="title"` at compact: `min-h-[52svh]`, text from `--spacing-bar + 0.5rem`, logo ≤ 96 pt and 70 % wide, string synopsis → `Overview` (3 lines, "More"/"Less" only when the clamp cuts; measured, so jsdom never shows it). Actions container is `w-full`, Play `flex-1`.
- Actions: Play | Library | Watched | `TitleMoreMenu` (`title-more.tsx`: Trailer, tracking watchlist, Rate sub-page, Mark watched, Share via `navigator.share`). `TrackingActions` and the Trailer round button render only off compact. `TitleMeta` compact = year · 2 genres · IMDb (TMDB score if no IMDb).
- Episodes at compact: 22 pt heading, a `•••` (`More for Season N`) holds Mark season (un)watched; cast faces 64 pt; related posters `dense` at 7.5 rem.
- Picker at compact: `PageHeader` = 56 pt strip with blurred art, h1 "Streams" (sr-only title after it) and `S2 · E4 · Name` (the title for a film). `StreamList` reads `useCompactShell()`: 64 pt two-line rows (quality + source + size, then a scrolling `Badges line` + warning icon + addon + 44 pt file button), top pick card 16 pt padding, 28 pt quality, full-width Play (`tabIndex -1`; the card button stays the named row), 13 pt uppercase headings, stuck band flush under the bar (`phoneStickGap`). `StreamsSummary` drops the chip rail for one addon that answered (also in the player's switcher).
- Not built/verified: nothing was run on a device or in a simulator, tests not written (left for the user); verify the Back stacking, the picker's "top pick + 4 rows" claim and the blurred header on the iPhone.
