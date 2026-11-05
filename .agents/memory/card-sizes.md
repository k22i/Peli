---
name: card-sizes
description: "#113 cards at 1.5× (15rem posters, 27rem landscape), lib/artwork-url.ts sharper() in Artwork, Home rows capped at 10 with Browse all, memory numbers and the deferred Browse-grid cache growth"
metadata:
  type: project
---

#113 (redesign epic [[redesign-epic]]) made cards 1.5× (the user first said 2×, then changed it): `--container-poster: 15rem` and `--container-landscape: 27rem` in `index.css`, with `cardRem` in `row.tsx` kept in step (a test checks it). Gaps are 24px (grid rows 40px), caption estimate 56. `Artwork` takes a `use` prop (`poster`, `landscape`, `backdrop`, `logo`, `avatar`) and runs the URL through `lib/artwork-url.ts` `sharper()`: Metahub poster/background small → medium, TMDB posters w500, stills w780, cast w342, and the original URL is tried once if that fails. Home's catalog rows show `homeRowLimit` = 10 titles and a "Browse all" link (`browseTarget` in `lib/browse.ts`) to the Movies/Shows/Anime page with that chip chosen; rows with no browse page keep all their titles.

**Why:** the user wanted bigger posters; a bigger card decodes a bigger bitmap, and WebKit keeps decoded images. At 2× with Metahub `large` art the Long rows test reached about 1.9 GB, so the art stays at the size the card needs (a 15rem poster is 480 device px, `medium` is 500). Metahub's `background/medium` is already 1920×1080 and `large` is the same file; logos are one file at every size.

**How to apply:**
- Use `use` on any new `Artwork` of a card, still or cover; leave hero backdrops without it.
- Memory (Playwright WebKit, generated art at the real bitmap size): Home-like page 1.0× after the change; scrolling a 1,000-poster grid end to end keeps 3–4× (1.4–1.7 GB vs 0.45 GB), falling to about 245 MB on `org.WebKit.lowMemory`. That is cache, same as [[virtualized-rows]]; fewer images are mounted than before, so `overscan` isn't the lever. Deferred by the user and noted on #125.
- Harness: throwaway entry in `frontend/` (relative imports, a vite config with `root` and its own `cacheDir` per tree, two trees can share `node_modules` by symlink) plus a Playwright script summing `footprint` of the `ms-playwright/webkit` processes.
- Tests weren't run for #113 (the user asked to skip them); run `pnpm test` first when picking this up.
