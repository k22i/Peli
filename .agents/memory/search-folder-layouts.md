---
name: search-folder-layouts
description: "#119 Search on BrowseFrame (quietTitle, glass h-14 field + clear + ⌘F hint, row bylines via searchGroups.addons), folder header (compact Hero banner or CoverHeader with Ambient), gotchas"
metadata:
  type: project
---

#119 (redesign epic [[redesign-epic]]) rebuilt Search and the folder header. `BrowseFrame` (browse-page.tsx) is now exported and has a `quietTitle` prop: once stuck the `h1` is `sr-only` and its row gives back `-mb-3`. Search passes the field as `rail`. `SearchField` is a coss `Input` with `unstyled` plus `glass flex h-14 w-full rounded-2xl` on the wrapper and `[&_input]:…` arbitrary variants for the `<input>` (coss sets the input's own class and `className` only reaches the wrapper). The clear button is a plain `glass-thin` button (refocuses via an input ref + `useImperativeHandle`); the `Kbd` hint shows while empty and unfocused. `searchGroups` returns `addons` (names, addon order) and `groupByline` formats them; `Row`'s `title` is now a `ReactNode`, so the heading reads "Movies · Cinemeta" with the addon muted. The folder header: `Hero compact` (new additive prop, `min-h-72`, also on `HeroSkeleton`) for landscape/no cover, `CoverHeader` (cover `w-56` + title block over `Ambient`) for POSTER/SQUARE covers.

**Why:** the ticket asked for an Apple Music-style search bar and a folder header that follows the cover shape.

**How to apply:**
- The coss `Input` wrapper is `inline-flex` only when not `unstyled`: add `flex w-full` yourself or the glass paints per line box (a thin pill).
- A glass field inside the stuck glass header is a backdrop root, so it only tints (looks fine; don't "fix" it).
- No recent searches exist anywhere (nothing stored), so none are shown; add storage first if that's wanted.
- Group regions are named "Movies · Cinemeta": tests match `^Movies( ·|$)` (`named()` in search.test.tsx).
- Ambient bleeds with `top-[calc(-1*(var(--titlebar-h)+1.5rem))] -ms-(--sidebar-inset)`; the folder wrapper's `py-6` is the 1.5rem.
- Hero's eyebrow is still mono (not mine); the folder passes a `font-sans font-semibold tracking-[0.06em]` span to get the Mona Sans label look.
- Screenshot rig: [[app-shell]] harness (Proxy stubs, hash URLs); scene via `sessionStorage` set on a first load, then `about:blank` and the real hash URL (a query on the base URL leaks into the hash route's `q`); a local node addon with a 5-minute search delay gives the "Searching…" state.
- Tests weren't run (user asked to skip): `search.test.tsx` (new byline, clear and hint tests, `named()` helper, heading "Search your addons’ catalogs"), `search.test.ts`, `folder.test.tsx` (two header tests), `contrast.test.ts` (two new pairs).
- Related: [[search-page]], [[collection-folders]], [[chip-rail]], [[home-hero]], [[glass-materials]].
