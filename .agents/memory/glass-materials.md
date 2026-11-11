---
name: glass-materials
description: "#111/ADR-0046 glass tiers in index.css: utilities, tokens, reduced-transparency variant, scroll-edge-top, Ambient, backdrop-root gotchas"
metadata:
  type: project
---

**Superseded by `feat: revamp ui` (32b700d, 2026-11-11):** the `glass-*` utilities are gone. `index.css` now has three materials, `material-bar` (top bar over scrolled content), `material-pop` (menus, selects, tooltips, toasts) and `material-media` (controls over artwork or video, light on dark), each solid under `reduced-transparency:` (which also covers increased contrast). The player's sheets (subtitle panel, Picture & sound) use their own warm near-black surface, `bg-[rgb(18_16_14/0.86)]` + `backdrop-blur-3xl`. What follows is the #111 history; the backdrop-root gotchas still hold.

#111 (redesign epic [[redesign-epic]]) put the glass in `frontend/src/index.css`: `@utility glass-thin | glass | glass-thick | glass-media | glass-media-strong`, tokens `--glass-*` (hex, in `:root` and `.dark`), `--popover` = the regular tint. coss popups are mapped by selector with `@apply` (menu, tooltip, toast → `glass`; dialog, sheet → `glass-thick`); the select's inner list has the `glass` class. `reduced-transparency:` is a custom Tailwind variant (media query or a `data-transparency="reduced"` ancestor); the tiers use `@variant` inside `@utility` for their solid fallbacks. `scroll-edge-top`, `components/media/ambient.tsx` and the gallery's `Materials` section (`gallery/materials.tsx`) came with it. ADR-0046 and the Glass section of `docs/design/README.md` hold the table.

**Why:** the epic wants one set of materials so later tickets never hand-roll `backdrop-blur`.

**How to apply:**
- Pick a tier class; never `bg-popover` without one (it is translucent now: use `bg-card`/`bg-background`/a tier). A tier sets its own `background-color`, so don't add `bg-*` to the same element.
- A `backdrop-filter`, `filter`, mask or opacity < 1 makes a backdrop root: a glass element inside another glass element (or inside a fading popup) blurs nothing of the page. `scroll-edge-top` therefore goes on a wrapper, not on a glass header. Needs a positioned element.
- Ambient's parent must be `relative isolate`; with no `src` the art tone shows the brand glow.
- Contrast: glass pairs are in `contrastPairs` with literal `#000000`/`#ffffff` backdrops (worst cases, both modes). Thin text is only checked over page and card.
- Screenshots without the Go services: a throwaway entry file (`shot.html`, `shot-main.tsx` importing `./src/...` relatively, a `shot.config.ts` with react + tailwind) in `frontend/`, `vp dev --config`, and a CDP script with `Emulation.setEmulatedMedia` for colour scheme; delete the files afterwards.
