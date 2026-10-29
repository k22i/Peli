---
name: home-page
description: "How Sinag's Home (#42) is built: homeRows order, hero choice, usePlay seam, CatalogVisible batching, test fetch stub and the WebKit cache-timing harness; read before #43–#46, #52, #60, #64"
metadata:
  type: project
---

Home (#42, ADR-0026) is `routes/index.tsx`. Row order comes from `homeRows(layout, collections, loadedAddons, visible)` in `lib/home.ts`: layout sections first, then catalogs the layout doesn't name, in addon order, with no-extras catalogs only. Kids filtering goes through `hiddenCatalogsQuery` (one batched `CatalogVisible` query under `["addons", id, "visible", …]`), wrapped with the manifests in `useBrowsableAddons` (shared with browse, #43). The hero is the first catalog row's first item with a backdrop: Resume if it's in Continue Watching, else Play, falling back to the last watched title.

**Why:** the user's layout or addon order decides what's first, and Home must paint from cache (measured 250–290 ms warm and offline in WebKit).

**How to apply:**
- Start playback only through `usePlay()` (`lib/playback.ts`). It's a toast until the stream picker (#52) and player (#60, #64) connect it.
- `MetaPreview.released` is parsed now. Use `isReleased` for `hideUnreleased`.
- Tests: `routes/home.test.tsx` has `serve({path: fixture})`, which stubs `fetch` and answers 503 for anything else. `renderApp(path, { seed })` pre-fills the cache the way a restored persisted cache would. Mock `CatalogVisible` on `@bindings/store`.
- Timing harness: `frontend/vite.stub.config.ts` (throwaway; delete it afterwards) aliases `@bindings/*` to scratchpad stubs, which wrap `Service` in a Proxy that delays every call by 40 ms and keeps `CacheGet`/`CacheSet` in localStorage. Then run `vp build` + `vp preview`. In Playwright WebKit, the first run serves the Cinemeta fixtures through `context.route`, waits 2.5 s for the persister, then aborts the route and records MutationObserver marks.
- Related: [[virtualized-rows]], [[addon-protocol-client]], [[kids-profiles]], [[sync-module]], [[browse-pages]].
