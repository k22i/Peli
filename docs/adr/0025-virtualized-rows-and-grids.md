---
status: accepted
date: 2026-10-29
---

# Virtualized rows and grids: TanStack Virtual, roving focus by index, and freeing images on unmount

#41 makes poster rows and grids cheap enough for the memory target (ADR-0005). WKWebView keeps every decoded `<img>` in the DOM decoded, so an unvirtualized Home with 200 posters measured 203 MB of the 250 MB budget (#7). The page lanes (#42–#46) build on these components.

## TanStack Virtual, data-driven components

`@tanstack/react-virtual` fits the TanStack stack and does horizontal lists and windowed grids. We didn't want to hand-roll range maths.

- **`Row`** (`components/media/row.tsx`) takes `items`, `getKey`, `renderItem` and `card` (`"poster"`, `"landscape"` or a function per item) instead of children. It mounts the cards near the viewport, plus three either side. Cards are fixed widths (`--container-poster`, `--container-landscape`; a test keeps the numbers in step with `index.css`), so the row isn't measured. Every card sits in one grid cell, pushed along by `margin-inline-start`. This keeps snapping, the gutter (read from the computed `scroll-padding`) and the paging arrows as they were.
- **`PosterGrid`** (`components/media/poster-grid.tsx`) virtualizes by row and scrolls with the page (the nearest scrolling ancestor: `#content`, or `<main>` on narrow windows). It fits as many poster widths as it can and stretches them by overriding `--container-poster`, then measures each row at its tallest card.
- **`RowGroup`** wraps the rows on a page so ↑/↓ can move between them.

We dropped the children API. A virtualized list needs items, not rendered elements, and keeping two APIs would mean two code paths for focus.

## Roving focus by index

A row or grid is one Tab stop (`useRovingItem` in `components/media/roving.tsx`; the cards call it). Focus moves by index, because the target card may not be mounted. The virtualizer's `rangeExtractor` always includes the active card, so the Tab stop exists and the focused card survives being scrolled away. `focusIndex` makes a card active, waits for it to mount, then focuses it and scrolls it into view.

- **Row:** ←/→, Home and End. Inside a `RowGroup`, ↑/↓ move to the card in the next row nearest in x. Rows scroll with `scrollIntoView`, which moves the page too.
- **Grid:** all four arrows, plus Home and End. ↓ from above a short last row lands on its last card. The grid scrolls with the virtualizer's `scrollToIndex`. A smooth `scrollIntoView` stopped short on long jumps, because the rows measured on the way moved its target.

## Images

- **`Artwork` remembers what each URL did this session** (up to 2,000 URLs). A card scrolled back into view mounts a fresh `<img>`. If its URL has loaded before, it shows at once instead of fading in from the placeholder again. A URL that failed isn't fetched again. The bytes come from WebKit's cache. There's no disk cache on the Go side.
- **An `<img>` that leaves the document drops its `src`.** WebKit keeps a detached image's decoded pixels until JS garbage collection, seconds later. Dropping `src` releases them at once. The check runs after the commit, so Strict Mode's rehearsal unmount doesn't clear a live image.
- `loading="lazy"` stays. Before virtualization it was already what kept idle memory down: off-screen posters weren't decoded until scrolled to.

## Measurements

These are Playwright's WebKit (macOS 27, the same engine as WKWebView) and Chromium headless shell, at 1280×800. The page is the gallery's "Long rows" section: 200 distinct 342×513 JPEGs, as #7 drew them, and a 1,000-poster grid. The cards are driven one step per frame. Memory is the WebContent process's `phys_footprint`.

**WebKit memory, 200-poster row, MiB:**

| | Idle | After one sweep | +15 to 30 s | After 3 more sweeps |
|---|---|---|---|---|
| Unvirtualized, lazy images | 103 | 200 | 189 | 199 |
| Virtualized | 102 | 228–247 | 140–232 | 213–247 |
| Virtualized, dropping `src` on unmount | 103 | 169–183 | 143–160 | 162–171 |

After a full sweep of the 1,000-poster grid, WebContent settles 70–100 MiB above idle. Across six sweeps it plateaued at 180–225 MiB. That's WebKit's memory cache, which macOS purges under memory pressure, not a leak. About 30–50 `<img>`s are in the DOM at any time.

**Frames slower than 25 ms (a missed 60 Hz frame), 3 runs each:**

| | WebKit | Chromium |
|---|---|---|
| Row, 200 posters in 6 s (~5,700 px/s) | 0–1 of ~432 (p95 15–16 ms) | 0 of 361 |
| Grid, 1,000 posters in 20 s (~2,900 px/s) | 0–2 of ~1,440 (p95 16 ms) | |
| Grid, 1,000 posters in 6 s (~9,700 px/s) | 2–6 of ~430 (worst 27–43 ms) | 0–2 of ~360 |

Memoizing the cells, so a scroll frame doesn't re-render mounted cards, made no measurable difference, so it isn't done.

## What we give up

- **WebKit's memory cache still holds recently shown posters.** That's tens of MB after long browsing, which macOS purges under memory pressure. Bounding it further needs WebKit's private cache-model API.
- **Headless WebKit isn't vsync-locked** (median frame 14 ms), and it isn't the system WKWebView. The final check is the gallery's scroll test in the macOS app.
- **Find in page (⌘F) can't find cards that aren't mounted.** Search (#44) is the way to find a title.

## Revisit if

Real poster art on a real Home (#42, #87) measures over budget; or WebKit starts dropping decoded images itself, as WebView2 does.
