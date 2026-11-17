---
name: library-iphone
description: "#132 the Library on iPhone: CompactLibraryFrame (large title → 17 pt bar, --library-header-h), full-width switch, Sort ResponsiveMenu, PosterGrid dense (--poster-dense-columns), Card dense/corner, compact Upcoming rows + collapsible Later, toasts above --tabs-float"
metadata:
  type: project
---

#132 (epic #126, 2026-11-17) gave the Library a phone layout on the compact iOS shell (`useCompactShell()`). Desktop and the iPad full screen keep the old paths: `LibraryFrame` picks `BrowseFrame` or `CompactLibraryFrame`.

**Why:** the user said "the library page is not optimized for mobile": the title and switch wrapped, Sort took half the width, and the grid showed 4 titles a screen.

**How to apply:**
- `components/library/compact-frame.tsx`: a 34 pt display title with Sort (`SortMenu` in library-page.tsx, a #134 `ResponsiveMenu` with radio rows) at its end, `ViewSwitch compact` (grid of 2 or 3 equal segments, h-9), chips on their own row, and the `sortCaption()` line. The 44 pt glass bar (`-mb-11`, `pointer-events-none`, hidden at `ios-short`) shows the 17 pt title once an IntersectionObserver sees the h1 wholly under it. Its measured height goes to `--library-header-h` on the page root, and the page root also sets `--spacing-page` to 16 pt plus side insets.
- Upcoming's compact day headers use `top: calc(var(--spacing-bar) + var(--library-header-h, 0px))`. The desktop keeps `stuckHeader` (4.375rem). Later is collapsible only on compact.
- `PosterGrid dense` reads `--poster-dense-columns` from `<html>` (index.css: 3 at compact, 6 at height < 500). When it's unset (desktop, iPad, jsdom) the grid stays ordinary, so jsdom tests see one column as before. Gaps are 8/14 px, with a 34 px caption estimate.
- `Card` `dense` (13/11 pt caption, edge progress bar with no scrim) and `corner` (top-right slot, used for the Watchlist's SIMKL "S" / AniList "A" marks from `WatchlistItem.services`). Library progress = `progressFractions(continueWatching)` (entries at 0 are left out). Meta = `denseLibraryMeta` (episode, else year).
- Toasts: the shell toggles `data-tabs` on `<html>` while the tab bar shows, and index.css lifts the bottom toast viewport to `--tabs-float`.
- `LibraryGridSkeleton` / compact `LibraryNotice` (centred in `100dvh - bar - tabs - 11rem`) are in notice.tsx.
- Not done: tests (`library.test.tsx` with `onCompactIOS()`) and device screenshots `docs/ios/epic126-132-*.png`. Pull to refresh is #135.

Related: [[library-redesign]], [[library-page]], [[upcoming-episodes]], [[bottom-sheets]], [[app-shell]], [[card-sizes]], [[ios-port]].
