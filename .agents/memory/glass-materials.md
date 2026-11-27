---
name: glass-materials
description: "#111/ADR-0046 glass tiers in index.css: utilities, tokens, reduced-transparency variant, scroll-edge-top, Ambient, backdrop-root gotchas"
metadata:
  type: project
---

**Superseded by `feat: revamp ui` (32b700d, 2026-11-11):** the `glass-*` utilities are gone. `index.css` now has three materials, `material-bar` (top bar over scrolled content), `material-pop` (menus, selects, tooltips, toasts) and `material-media` (controls over artwork or video, light on dark), each solid under `reduced-transparency:` (which also covers increased contrast). The player's sheets (subtitle panel, Picture & sound) use their own warm near-black surface, `bg-[rgb(18_16_14/0.86)]` + `backdrop-blur-3xl`. What follows is the #111 history; the backdrop-root gotchas still hold.

**Highlights on the materials (2026-11-27):** each material now carries a specular top edge (`--rim-lit`, 16 % warm white) and, for bar and pop, a wash off the top-left (`--sheen-bar` 6 %, `--sheen-pop` 8 %). Both are `background-image` layers — `linear-gradient(var(--rim-lit), var(--rim-lit))` with `background-size: 100% 1px` for the edge, a `radial-gradient` for the wash — **not** `box-shadow` or a `::before`: components put their own hairline (`shadow-[0_1px_0_var(--border)]` on every sticky bar), border and `hover:before:` on these elements, and a pseudo-element or a shadow property would collide. On a pill the 1px edge shortens towards the ends of the curve, which reads as a glint. Media gets no wash: it holds white text over video and its tint is sized for the worst frame. `contrastPairs` gained "Text on the bar's wash, over white" (6.9:1) and the pop one (8.8:1); the tokens are hex-with-alpha so the test can read them.

**`data-transparency="reduced"` was dead from the revamp until 2026-11-27:** 32b700d dropped the `&:where([data-transparency="reduced"], [data-transparency="reduced"] *)` branch of the `reduced-transparency` variant, so the gallery's toggle did nothing. Restored. If a gallery toggle or docs claim a CSS state can be forced without the OS setting, check the variant, not the component.

#111 (redesign epic [[redesign-epic]]) put the glass in `frontend/src/index.css`: `@utility glass-thin | glass | glass-thick | glass-media | glass-media-strong`, tokens `--glass-*` (hex, in `:root` and `.dark`), `--popover` = the regular tint. coss popups are mapped by selector with `@apply` (menu, tooltip, toast → `glass`; dialog, sheet → `glass-thick`); the select's inner list has the `glass` class. `reduced-transparency:` is a custom Tailwind variant (media query or a `data-transparency="reduced"` ancestor); the tiers use `@variant` inside `@utility` for their solid fallbacks. `scroll-edge-top`, `components/media/ambient.tsx` and the gallery's `Materials` section (`gallery/materials.tsx`) came with it. ADR-0046 and the Materials section of `docs/design/README.md` hold the table.

**Why:** the epic wants one set of materials so later tickets never hand-roll `backdrop-blur`.

**How to apply:**
- Pick a material class; never `bg-popover` without one (it is translucent now: use `bg-card`/`bg-background`/a material). A material sets its own `background-color` and `background-image`, so don't add `bg-*` to the same element (a `hover:bg-*` colour is fine).
- The highlights are background layers, so don't reach for `box-shadow` for a new edge — that property is the one components already own.
- A `backdrop-filter`, `filter`, mask or opacity < 1 makes a backdrop root: a glass element inside another glass element (or inside a fading popup) blurs nothing of the page. `scroll-edge-top` therefore goes on a wrapper, not on a glass header. Needs a positioned element.
- Ambient's parent must be `relative isolate`; with no `src` the art tone shows the brand glow.
- Contrast: material pairs are in `contrastPairs` with literal `#000000`/`#ffffff` backdrops (worst cases). The wash is the brightest point of a surface, so text that can reach it is measured with the sheen token layered on top.
- Screenshots without the Go services: a throwaway entry file (`shot.html`, `shot-main.tsx` importing `./src/...` relatively, a `shot.config.ts` with react + tailwind) in `frontend/`, `vp dev --config`, then Chrome `--headless=new --screenshot --force-device-scale-factor=1 --window-size=…` (no CDP needed for a static state; a `#hash` switch in the entry picks the variant). Read pixels back with `ffmpeg -i shot.png -f rawvideo -pix_fmt rgb24 out.raw` + node, which is how the 1px edge was verified; delete the files afterwards.
