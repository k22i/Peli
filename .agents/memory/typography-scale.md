---
name: typography-scale
description: "#112 type scale (option B): text-display/title/heading/body/item/caption/label/num utilities, twMerge extension, mono rule, text-card colour clash, screenshot rig notes"
metadata:
  type: project
---

**Superseded by `feat: revamp ui` (32b700d, 2026-11-11):** the type utilities are now `type-hero`, `type-display` (Instrument Serif, a few large moments), `type-title`, `type-row`, `type-item`, `type-eyebrow` (11px uppercase, was `text-label`) and `tnum` (tabular numbers, was `text-num`). Small text uses `text-small` / `text-tiny`. What follows is the #112 history.

#112 (redesign epic [[redesign-epic]]) rolled out the user's pick, **option B · Semi-wide** ([[peli-design-direction]]). Tokens live in the `@theme` "Type" block of `index.css`; the `@utility` blocks after it add what a token can't carry.

- `text-display` (hero, 112.5% width, 700, −0.03em, clamp 2.5–4.5rem), `text-title` (112.5%, 660, −0.02em, 2.25rem), `text-heading` (100%, 640, −0.015em, 1.375rem) set family and `font-stretch` themselves. **No page writes `font-heading` or `font-stretch-*`** (grep finds none).
- `text-body` 15px / 450 / 1.45 is on `body`, so content inherits it. Dense controls (menus, chips, sidebar items, pane list) keep `text-sm`.
- `text-item` 15px / 550: card captions, settings row labels, names. `text-caption` 13px: secondary lines and card meta. `text-meta` (12px) is left for tooltips and badges. `text-label` Mona Sans 12px / 600 / +0.06em **uppercase** (eyebrows, `dt`, "Top pick", menu group labels). `text-num` Geist Mono + tabular-nums.
- Mono is for numbers and codes only: years, runtimes, `S2 · E5`, times, sizes, versions, ids/hosts. Hero meta passes nodes (`<span className="text-num">` for numbers, plain for genres): see `metaLine` in `routes/index.tsx` and `title-page.tsx`.

**Gotchas**
- `text-card` is coss's card *colour* utility (`--color-card`), so a size token named `card` painted text in the card background. The token is `text-item`. Check any new `--text-*` name against the colour tokens (`card`, `popover`, `muted`, …).
- `lib/utils.ts` `cn` uses `extendTailwindMerge`: the size tokens are registered under `theme.text` and `text-num` under `font-family`, otherwise tailwind-merge reads `text-title` as a colour and drops it next to `text-white`. Add a new `--text-*` token to that list too. (`StreamBadge` still avoids `cn` for an older reason; it works the same now.)
- A `@utility text-title` and the theme token of the same name both emit: Tailwind merges them into two rules, no conflict.
- Sticky Browse header animates `text-title` → `text-heading`; its `transition-[...]` lists `font-stretch,font-weight` so the width change doesn't snap.
- Gallery: Foundations › Type lists the scale, "Type in use" (`gallery/type-sample.tsx`) shows a hero, row, title block, settings row and time readout with the real utilities. The A/B/C switch is gone; the specimen JPGs stay in `docs/design/`.
- Screenshot rig: throwaway `vite.shot*.config.ts` in `frontend/` + stubs in the scratchpad; a `shot.html` entry that sets `window.router` reaches `/player` with a state; `window.__emit("player:state", …)` drives the bar; stub `store.ProfileSettings`/`DeviceSettings` or a Settings pane renders empty. The `@wailsio/runtime` alias must be a resolve plugin limited to `src/` importers, or the wails vite plugin breaks. For "before", `git worktree add --detach` the start commit, symlink `node_modules`, run `./node_modules/.bin/vp dev` (pnpm exec fails on the symlink).
