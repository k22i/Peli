---
name: motion
description: "#124 motion: data-nav from lib/nav-direction (history index), sliding nav/settings pills (resolved location, named lists above pill groups), Button press scale, reduced motion, CDP checks of view transitions"
metadata:
  type: project
---

#124 (redesign epic [[redesign-epic]]) added the motion pass, CSS only. `lib/nav-direction.ts` (`navDirection`, `trackNavDirection`, called from `createAppRouter`) sets `<html data-nav="forward|back|section">` in the router's `onBeforeLoad` from the history index (`__TSR_index`): lower index = back, a push into `/title/`, `/folder/` or `/streams/` = forward, everything else (and same-path or replace) = section. `index.css` keys `::view-transition-new(content)` off it (`nav-enter-forward` 0.985 / `nav-enter-back` 1.015, `--duration-slow`, `--ease-smooth`). Pills: `span[data-slot="nav-pill"]` (sidebar, `[view-transition-name:nav-pill]`) and `span[data-settings-pill]` (`settings-pill`); groups animate at `--duration-base` with `--ease-spring`. `Button` has `motion-safe:active:scale-[0.97]` (link excluded); sidebar items, Settings panes and episode rows use 0.99.

**Why:** the epic wants feedback on press, transitions that leave the way they came, and nothing that moves under reduced motion.

**How to apply:**
- Nothing sets `data-nav` by hand: any navigation (Link, `navigate`, `history.back`, popstate) is covered. Don't clear it: the pseudo-elements are styled after the update callback, the next navigation overwrites it.
- The sidebar's `pathname` is `useRouterState` on `resolvedLocation`, not `useLocation`: `useLocation` changes before the transition captures its old state, so the pill would already sit on the new item and never glide. Keep that for anything else that must animate between routes.
- Named elements are captured separately and the groups paint in `z-index` order, not DOM order: a pill group above the panel would cover its labels (the light pill is opaque; `mix-blend-mode` on the image pair does nothing, each group is its own stacking context). So the `<nav>` lists are named (`sidebar-nav`, `settings-nav`, z 3) above the pills (z 2) and the sidebar (z 1).
- `getComputedStyle(documentElement, "::view-transition-group(nav-pill)")` and `document.getAnimations()` (filter on `effect.pseudoElement`) show a transition's progress in headless Chrome; `Page.startScreencast` frames + ffmpeg concat (timestamps as durations) make an MP4, but screencast misses some frames mid-glide, so also sample the group's transform.
- The hero Play is solid white, so `hover:brightness-110` would do nothing; it keeps `hover:bg-white/90`. Glass hero buttons keep `hover:before:bg-white/15` (#115).
- Back button: its transition is `[color,background-color,scale]` at `--duration-fast`; twMerge drops Button's own transition class, so name `scale` in any override.
- Tests weren't run (the user asked to skip them): the new ones are `lib/nav-direction.test.ts`, the pill cases in `app-shell.test.tsx` and `settings.test.tsx`. Open: built app with macOS Reduce motion, WKWebView view-transition check (Safari 18+).
- Related: [[glass-materials]], [[app-shell]], [[settings-panes]], [[title-page-redesign]].
