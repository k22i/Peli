---
name: app-shell
description: "#114 floating glass sidebar and title bar: --sidebar-inset/--titlebar-h, bleed utility, visual order vs sections.ts, scroll edge cover, window colour = --background, stubbed-shot harness"
metadata:
  type: project
---

#114 (redesign epic [[redesign-epic]]) turned `components/shell/` into: `#content` fills the window (`fixed inset-0`), padded by `ps-(--sidebar-inset) pt-(--titlebar-h)`; a `fixed` `glass-thick` sidebar (`start-2 top-2 bottom-2`, `w-60` from md, `w-16` rail below); a `fixed` title strip (`TitleBar`, `scrolled` prop from `useScrolled(pane)` in `app-shell.tsx`, also `data-scrolled` on `#content`). `--titlebar-h` comes from a class per platform (`titleBarHeight`), `--sidebar-inset` from classes on the shell root. `bleed` (index.css) cancels both for hero art; Gallery › Shell (`gallery/shell.tsx`) shows it. `scroll-edge-top` gained `--scroll-edge-cover` so the blur also covers a background-less bar (the title strip sets it to `--titlebar-h`). Window colour is now `--background` (`theme.ts`, `main.go`, `theme.test.ts`).

**Why:** the user's Apple TV/Music layout. Search is a field-like link first in the sidebar, then Home–Anime, then Library; only the look changed.

**How to apply:**
- Sidebar order is `visualOrder` in `sidebar.tsx`; ⌘1–6 still use `sections.ts`. Arrow keys and the roving Tab stop follow DOM order, so Search is index 0 and wrap-around goes Library → Search. The Search link's ⌘F `Kbd` is `aria-hidden` so its name stays "Search".
- Sidebar links use `activeOptions { exact: true, includeSearch: false }`, so a chip or filter (`?genre=`) keeps its section highlighted; a stubbed page at `/?x=1` is still Home. Sidebar and title bar have their own view-transition groups (above `content`) so a route change never hides them.
- The md breakpoint is 768px, so a 900×700 window still has the full panel; the rail shows below 768.
- Sticky things inside `#content` need `top-[calc(var(--titlebar-h)+…)]` (Settings nav does).
- Brand-on-active-sidebar pairs (over black/white, via `glass-thick` + `brand-soft`) are in `contrastPairs`; checked by hand with node (4.5/3.14+ dark, 5.05 light).
- Screenshot harness that worked: `frontend/vite.shot.config.ts` (throwaway) aliasing `@bindings/<name>` to scratchpad Proxy stubs (`Service` answers by `service.Method`, models re-exported from the real `models.ts` when one exists) and `@/lib/platform` to a stub reading the hash; real Cinemeta over the network; CDP script as in [[spike-ticket-workflow]]. Chrome needs ~7 s to start. `git stash` the tracked changes for the "before" shots.
- Built app: `wails3 task darwin:package` takes ~10 s; the window that paints is the second "Sinag" id (the first is blank). osascript clicks and Option+Tab did not get past the welcome screen, so the native sidebar and traffic-light position were not checked (#114 open item).
- Tests weren't run (the user asked to skip them): `app-shell.test.tsx` (arrow order, nav order, scrolled), `theme.test.ts` and `contrast.test.ts` are the ones to watch.
