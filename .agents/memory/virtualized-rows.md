---
name: virtualized-rows
description: "How Sinag's virtualized Row/PosterGrid (#41) work, their test setup, and how to measure WebKit memory/frames without driving the app; read before #42–#46"
metadata:
  type: project
---

#41 (ADR-0025) made `Row` (`components/media/row.tsx`) and `PosterGrid` (`poster-grid.tsx`) virtualized with `@tanstack/react-virtual`. They're data-driven (`items`, `getKey`, `renderItem`, Row's `card`), with no children API. Wrap stacked rows in `RowGroup` for ↑/↓. Cards get roving focus from `useRovingItem` (`roving.tsx`).

**Why:** WKWebView keeps every <img> in the DOM decoded; 200 posters cost 128 MB (#7).

**How to apply:**
- Never map cards into a plain flex row for long lists; use Row/PosterGrid.
- Tests: jsdom has no layout, so `src/test/setup.ts` gives `[data-slot=row-scroller]`, `[data-slot=poster-grid]` and `#content` a 1280×800 client size. Cards come and go, so query them afresh instead of holding an array. A grid test needs a `#content` ancestor with `overflowY: auto`.
- `Artwork` no longer drops `src` when its <img> leaves the document: the user removed that in 940e74c (2026-10-29), though ADR-0025 still describes it. Ask before reinstating it.
- Measuring without driving the user's Mac: Playwright WebKit in the scratchpad (`pnpm add playwright@1.64.1`, `playwright install webkit`). Load a throwaway `frontend/stress.html` that renders `StressSection` (delete it afterwards). Its XPC processes are parented to launchd: find them by `ms-playwright/webkit` in `ps` and read `footprint -f bytes --noCategories <pid>`. Run engines one at a time.
- A smooth `scrollIntoView` across a virtualized list with measured rows stops short. Use `virtualizer.scrollToIndex`.
- Related: [[addon-protocol-client]], [[spike-ticket-workflow]], [[frontend-stack-preferences]].
