---
name: title-page-redesign
description: "#117 Apple TV-style title page: Hero size=title, BackButton (media glass → glass past the hero), sticky Episodes header + 30-season ChipRail, 2× episode rows, About card, cast on ScrollRail; files, gotchas, test status"
metadata:
  type: project
---

#117 (redesign epic [[redesign-epic]]) reworked `components/title/`: `title-page.tsx` (TitlePage, Title, LoadedTitle, `TitleMeta`, `RoundAction`), `back-button.tsx`, `episodes.tsx` (Episodes, `useStuck`, SeasonSelect), `episode-list.tsx` (virtualized rows), `about.tsx`, `cast-list.tsx`. `Hero` (`components/media/hero.tsx`) got `size="title"` (shares the `bleeds` branch with `feature`: bleed, widened scrim, fade; `min-h-[min(72vh,40rem)]`, logo `max-h-36`) and a `ref` prop for its section.

**Why:** the user's Apple TV layout: hero under the glass chrome, round glass actions, roomy episodes, info card. Details in `docs/design/README.md` (#117 section).

**How to apply:**
- TitlePage keeps the hero element in state (`heroRef={setHero}` down through Title → LoadedTitle → Hero) and hands it to `BackButton`, which observes it (root margin = the button's own bottom edge). No hero (skeleton, error) means plain `glass`. The skeleton has no ref on purpose (light grey, not dark).
- Library/Watched are icon-only (`RoundAction`: `Button variant="ghost" size="icon-xl"` + `size-11 sm:size-11`, coss Tooltip). The label is `aria-label` and the tooltip text: "Add to library"/"In library", "Mark watched"/"Watched". Don't add `aria-pressed` or visible text (tests and the names rely on it).
- `ghost` has `hover:bg-accent`: put `hover:bg-(--glass-media)` on a glass-media ghost button (twMerge swaps it), or the hover turns solid grey. Same for the Back button (`--glass-regular`).
- Button sizes carry an `sm:` variant (`icon-lg` is `size-10 sm:size-9`): override both (`size-10 sm:size-10`) or it shrinks at ≥640px.
- Episodes header: `grid-cols-[1fr_auto]`, DOM order heading → rail → button (Tab order per the ticket), the rail placed on row 2 with `col-span-2 row-start-2`. Stuck, the heading gets `ps-[calc(gutter+3.25rem)]` so it clears the fixed Back button. `useStuck` is the Browse header's sentinel trick (1px sentinel at the section top, root margin = header `top`).
- Rows: `li` is `inset-x-[calc(var(--spacing-gutter)-0.75rem)]` so the still lines up with the page text while the hover fill reaches past it; `rowPx` 252; the row button has `scroll-mt-[calc(var(--titlebar-h)+11rem)]` and the virtualizer `scrollPaddingStart: 176` so ↑/↓ and `scrollToIndex` don't hide a row under the sticky header (tune if the header's height changes). Unaired: only the still dims (`opacity-60` on the Artwork, never on a parent of a glass element), line is "S1 · E4 · Airs <date>" (runtime dropped).
- The watched check, play glyph and pill are white on glass-media/-strong, covered by the existing media-glass contrast pairs. Brand colour on glass-media over white fails 3:1, so the check isn't brand. New pairs: card labels on thin glass, muted text on the hovered row.
- Cast: `ScrollRail` around a `shrink-0` `ul` (the rail's children must be `shrink-0`); `shadow-card` not `shadow-lift` on the photos (the rail clips vertically). Cast/character stay `text-sm`: there's no caption token, #112 will retune.
- `heroButton` (press feedback) is duplicated from `routes/index.tsx` into `title-page.tsx`; fold both into one export if #124 touches them.
- Screenshots: the harness in [[app-shell]] and [[chip-rail]]; for a cast row without a TMDB key, a stub `Secrets.Get` returning a fake key plus a `window.fetch` override answering `api.themoviedb.org` (`/find` then `/movie|tv/<id>`) with names and `profile_path: null`. Don't run a throwaway Vite server across tool calls: it got killed between calls, start it and shoot in one command; check `lsof` for the port's cwd, another worker's server can own it.
- Status (2026-11-06): built and committed, not pushed (Actions down). `pnpm test` not run. Tests to watch: `routes/title.test.tsx` (new: IMDb pill, "Airs" wording, round button names, Back button material and sticky header via a stubbed IntersectionObserver, 30 vs 31 seasons), `contrast.test.ts`. Open: no Tab/focus-ring check in a real window; the hero Play focus ring over bright art wasn't photographed.
- Related: [[title-page]], [[home-hero]], [[chip-rail]], [[glass-materials]], [[card-sizes]].
