---
status: accepted
date: 2026-10-29
---

# Virtualized rows and grids: TanStack Virtual, roving focus by index, and WebKit's image cache

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
- **A removed `<img>` is left to the garbage collector.** WebKit keeps a detached image's decoded pixels until JS garbage collection, so we first dropped the `src` of every `<img>` that left the document. That kept every removed card alive instead: Chromium counted about 18,000 extra DOM nodes per scroll test, even after a forced GC. 940e74c took it out, and node counts now stay flat (below). What WebKit holds after that is its memory cache, which it hands back under memory pressure.
- `loading="lazy"` stays. Before virtualization it was already what kept idle memory down: off-screen posters weren't decoded until scrolled to.

## Measurements

These are Playwright's WebKit (macOS 27, the same engine as WKWebView) and Chromium headless shell, at 1280×800. The page is the gallery's "Long rows" section: 200 distinct 342×513 JPEGs, as #7 drew them, and a 1,000-poster grid. The cards are driven one step per frame. Memory is the WebContent process's `phys_footprint`.

**WebKit memory, 200-poster row, MiB:**

| | Idle | After one sweep | +15 to 30 s | After 3 more sweeps |
|---|---|---|---|---|
| Unvirtualized, lazy images | 103 | 200 | 189 | 199 |
| Virtualized | 102 | 228–247 | 140–232 | 213–247 |
| Virtualized, dropping `src` on unmount (removed: it leaked) | 103 | 169–183 | 143–160 | 162–171 |

After a full sweep of the 1,000-poster grid, WebContent settles 70–100 MiB above idle. Across six sweeps it plateaued at 180–225 MiB. That's WebKit's memory cache, which macOS purges under memory pressure, not a leak. About 30–50 `<img>`s are in the DOM at any time.

**Frames slower than 25 ms (a missed 60 Hz frame), 3 runs each:**

| | WebKit | Chromium |
|---|---|---|
| Row, 200 posters in 6 s (~5,700 px/s) | 0–1 of ~432 (p95 15–16 ms) | 0 of 361 |
| Grid, 1,000 posters in 20 s (~2,900 px/s) | 0–2 of ~1,440 (p95 16 ms) | |
| Grid, 1,000 posters in 6 s (~9,700 px/s) | 2–6 of ~430 (worst 27–43 ms) | 0–2 of ~360 |

**What WebKit gives back** (the current code, Playwright WebKit at 2×; WebContent MiB). `org.WebKit.lowMemory` is the notification macOS's memory-pressure handling sends WebKit; we posted it with `notifyutil -p`.

| | Idle | After scrolling | +20 s | 5 s after `org.WebKit.lowMemory` |
|---|---|---|---|---|
| Row only, there and back at ~1,700 px/s (2 runs) | 102–105 | 189–204 | 136–138 | 88–90 |
| The gallery's scroll test (row, then the 1,000-poster grid, 6 s each) | 104 | 185 | 159 | 110 |

DOM nodes didn't change across a run (119 before and after the row). In Chromium after a forced GC, three scroll tests in a row left 987, 987 and 987 nodes and a 17.3–17.5 MB JS heap.

**In the macOS app** (a throwaway build that opens on Long rows and runs the scroll test by itself, 999×617 window; the app and its WebKit processes, MiB):

| Posters loaded | Peak during the test | Held for the next 45 s | 5 s after `org.WebKit.lowMemory` |
|---|---|---|---|
| 305 | 1,118 | 917–919 | 131–134 |

So the memory is WebKit's cache, not a leak: it stays put while there's no pressure and goes in one step when asked. The scroll test is far faster than anyone scrolls (the grid at ~9,700 px/s). Frames in the app's own run of the test, on a 144 Hz display: the row missed 1 of 432 (p95 15 ms, worst 25 ms); the grid missed 10 of 332 (p95 21 ms, worst 35 ms), with 30 `<img>`s in the DOM.

Memoizing the cells, so a scroll frame doesn't re-render mounted cards, made no measurable difference, so it isn't done.

## What we give up

- **WebKit's memory cache holds recently shown posters until macOS asks for it back.** After the scroll test the app sat at about 920 MB until the low-memory notification, then 131 MB. With plenty of free RAM, Activity Monitor can show the app well over ADR-0005's 250 MB after heavy browsing, even though that memory is reclaimable. ADR-0005 measures idle with Home open, so #87 should measure after browsing too. A lead to try if it matters: clearing `WKWebsiteDataTypeMemoryCache` through `WKWebsiteDataStore` when the window goes idle or hides. That's public API, but we haven't checked that it frees decoded images.
- **Headless WebKit isn't vsync-locked** (median frame 14 ms), and it isn't the system WKWebView. That's why the frame and memory checks were repeated in the macOS app.
- **Find in page (⌘F) can't find cards that aren't mounted.** Search (#44) is the way to find a title.

## Revisit if

Real poster art on a real Home (#42, #87) measures over budget, including after browsing; or WebKit starts dropping decoded images itself, as WebView2 does.
