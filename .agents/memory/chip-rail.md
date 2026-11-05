---
name: chip-rail
description: "#116 ScrollRail/ChipRail (one-line sideways chips), BrowseFrame sticky glass header with IntersectionObserver sentinel, Library/stream-picker use, screenshot rig with a local 50-catalog addon"
metadata:
  type: project
---

#116 (redesign epic [[redesign-epic]]) added `components/media/scroll-rail.tsx` (`ScrollRail`: scroller with `no-scrollbar rail-fade`, edge fades from `data-at-start/-end` on the wrapper, `glass-thin` arrows rendered only when there is more that way and shown on hover/focus-within, vertical wheel → sideways while there is room, `onFocus` scrolls the child into view, `revealSelector` centres on mount) and `ChipRail` in `chip.tsx` (`ChipGroup` in a rail, `revealSelector="[data-pressed]"`, `railClassName` for the wrapper). Browse, Library's type chips and the stream picker's source pills use it. `BrowseFrame` in `browse-page.tsx` is the page: a `sticky top-(--titlebar-h)` header (title + filter row, rail row) that gets `glass` on an inner div once `data-stuck` (set by an IntersectionObserver on a 1px sentinel, rootMargin = −the header's own `top`), with `scroll-edge-top` on the sticky wrapper itself.

**Why:** with 50 catalogs the chips wrapped into a block that pushed the grid off screen.

**How to apply:**
- Rail width: the scroller carries `px-gutter` itself, so put a rail outside any `px-gutter` wrapper (Library's toolbar row has none; the Sort select takes `me-gutter`). In a gallery section use `railClassName="-mx-gutter w-[calc(100%+2*var(--spacing-gutter))]"`.
- Children of a rail must be `shrink-0` (Chip and the picker's pill are).
- jsdom has no IntersectionObserver or ResizeObserver: the rail and header guard for them. Rail tests stub `scrollWidth`/`clientWidth`/`scrollLeft` with `defineProperty`, then `fireEvent.scroll` and `findBy…` (measure runs on a rAF).
- Stuck glass: the wrapper keeps `scroll-edge-top` (no backdrop-filter), the inner div takes `glass` (see [[glass-materials]]).
- Screenshot rig: besides the stub harness in [[app-shell]], a node server on :9500 gave one addon with 50 movie catalogs (data proxied from Cinemeta) and 12 stream addons (one 503, one pending, one empty); the stub store listed those URLs. Hash URLs: `/#/movies?catalog=<encoded ref>`, `/#/streams/movie/tt0816692`, `/#/gallery`. The CDP script needed a `hover` step (`Input.dispatchMouseEvent`) to show the arrows.
- Status (2026-11-05): built and committed (5b7e3a5, ab39ca0), not pushed (Actions down); `pnpm test` not run yet. Tests to watch: `scroll-rail.test.tsx`, the new 50-catalog case in `routes/browse.test.tsx`, `library.test.tsx`, `streams.test.tsx`. Open items: the wheel mapping also takes plain vertical trackpad swipes over the rail (the spec asks for it); the sticky header covers the content area, not the strip under the sidebar.
- Related: [[browse-pages]], [[library-page]], [[stream-requests]], [[app-shell]].
