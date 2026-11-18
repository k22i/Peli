---
name: virtualized-rows
description: "How Peli's virtualized Row/PosterGrid (#41) work, their test setup, why src isn't dropped, and how to measure WebKit memory/frames (headless and in-app) without driving the app; read before #42–#46, #87"
metadata:
  type: project
---

#41 (ADR-0025) made `Row` (`components/media/row.tsx`) and `PosterGrid` (`poster-grid.tsx`) virtualized with `@tanstack/react-virtual`. They're data-driven (`items`, `getKey`, `renderItem`, Row's `card`), with no children API. Wrap stacked rows in `RowGroup` for ↑/↓. Cards get roving focus from `useRovingItem` (`roving.tsx`).

**Why:** WKWebView keeps every <img> in the DOM decoded; 200 posters cost 128 MB (#7).

**How to apply:**
- `PosterGrid` has `onEndReached` for infinite scroll (#43). Inside the real shell in tests, setup.ts makes `#content` scroll ([[browse-pages]]).
- Never map cards into a plain flex row for long lists; use Row/PosterGrid.
- Tests: jsdom has no layout, so `src/test/setup.ts` gives `[data-slot=row-scroller]`, `[data-slot=poster-grid]` and `#content` a 1280×800 client size. Cards come and go, so query them afresh instead of holding an array. A grid test needs a `#content` ancestor with `overflowY: auto`.
- Don't drop an `<img>`'s `src` on unmount: it kept every removed card alive (~18,000 extra DOM nodes per scroll test), so 940e74c removed it. ADR-0025 has the numbers.
- WebKit memory after scrolling is cache, not a leak: the app held ~920 MB after the gallery's scroll test and fell to 131 MB within 5 s of `notifyutil -p org.WebKit.lowMemory` (harmless, but every WebKit app on the Mac drops its caches). Post that before calling a number a leak.
- In-app check without sending input: temporarily replace `frontend/src/main.tsx` with a page that renders `StressSection` and clicks Load posters / Run scroll test on timers, run `wails3 task darwin:package`, copy `bin/Peli.app` to the scratchpad, restore main.tsx, rebuild. Launch with `open -n --env PELI_DATA_DIR=<scratchpad> <app>` (it comes to the front, so rAF isn't throttled) and sample `footprint` of the app plus WebKit processes started within ~8 s of it. The real app opens on the profile picker, not Home.
- Measuring without driving the user's Mac: Playwright WebKit in the scratchpad (`pnpm add playwright@1.64.1`, `playwright install webkit`). Load a throwaway `frontend/stress.html` + entry that renders `StressSection` inside a scrolling `#content` (delete both afterwards; outside `src` the `@/` alias doesn't resolve, so import relatively). Its XPC processes are parented to launchd: find them by `ms-playwright/webkit` in `ps` and read `footprint -f bytes --noCategories <pid>`. Run engines one at a time.
- iOS (#128, 2026-11-18): WebContent was jetsam-killed twice in a minute scrolling Movies on an iPhone 14 Pro with no memory warning first, Peli's own process at ~70 MiB. Causes found: TMDB `original` backgrounds (3840×2160, 33 MB decoded) in the hero and landscape cards, 500×750 posters (1.5 MB), WebKit keeping every shown image. Fixes: `sharper(url, use, device)` caps TMDB on iOS (backdrop w1280, landscape w780, compact poster w342; AniList `large`), Hero passes `use="backdrop"`; `Diagnostics.TrimWebCache` (iosshell `WKWebsiteDataTypeMemoryCache`) on memory warning, route change and each further grid page; catalog pages `gcTime` 1 min on iOS. The drop-src rule is NOT retested on iOS yet: the dev rig's "Tab loop, dropping src" row (`dropSrcKey` in artwork.tsx) is the retest; record its result here. WebContent's footprint can't be read from the page or the app; the rig logs `decoded=`, `fetched=`/`fetchedMB=` (Resource Timing) per step.
- A smooth `scrollIntoView` across a virtualized list with measured rows stops short. Use `virtualizer.scrollToIndex`.
- Related: [[addon-protocol-client]], [[spike-ticket-workflow]], [[frontend-stack-preferences]].
