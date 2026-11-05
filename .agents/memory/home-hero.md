---
name: home-hero
description: "#115 Hero size=\"feature\" (full-bleed, fade under text), hero buttons, row link/arrows, Continue watching pill + timeLeft, Home layout wrapper"
metadata:
  type: project
---

#115 (redesign epic [[redesign-epic]]) added `Hero`/`HeroSkeleton` `size="feature"` (`components/media/hero.tsx`): `bleed` section, `min-h-[min(80vh,46rem)]`, text block padded `ps-[calc(var(--sidebar-inset)+var(--spacing-gutter))]` with an inner `max-w-3xl`, widened start scrim, and a `h-32` fade to the page colour. Home passes it. Home's layout is `flex-col pb-12` with the hero first and a `gap-12 pt-6` wrapper for the rows (RowGroup renders no element, so its rows are that wrapper's children). Hero buttons: Play solid white pill, Details `glass-media-strong` pill (`hover:before:bg-white/15`), `heroButton` const in `routes/index.tsx`. `rowLinkClassName` (row.tsx) styles "See all"/"Browse all" with a chevron. Paging arrows are `glass-thin size-12`, `top` from `arrowTop` (artwork centre, first item's shape). `Card` has a `pill` prop (top-right, `glass-media-strong`); Continue watching shows "S2 · E5" there and `timeLeft(entry)` (lib/library.ts, ms) as its meta.

**Why:** the user's Apple TV layout: hero under the sidebar, glass actions, shelves spaced for 1.5× cards.

**How to apply:**
- The fade must not be a later sibling outside the dark scope: it paints over the buttons. It lives inside the scope as `from-(--fade)` with `--fade:var(--background)` set on the section.
- Details uses the strong tint (text); the plain `glass-media` is for icon-only (3.4:1 over white). Don't use `hover:bg-white/*` on glass: it replaces the tint.
- `--card-w` doesn't exist; use `--container-poster`/`--container-landscape`.
- Left as is: the #112 row-heading and body sizes (not rolled out yet); the button label is still "Details".
- Tests weren't run (the user asked to skip them): `home.test.tsx` (hero Play/Resume, card text "S1 · E2"), `row` tests, `contrast.test.ts` (new "Hero Play button" pair).
- Screenshot harness as in [[app-shell]]; stub the Library/ContinueWatching handlers with real Cinemeta ids so the art loads.
