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

**The marquee keeps room for its buttons and dashes (2026-11-27).** Home's marquee draws `Play`/`Details`/`Surprise` and the dashes *once*, in an absolute overlay at the bottom of the frame, so they stay put while the slides turn; each slide keeps the room they take with invisible copies (`actions`, and since this `aside`). The dashes were missing from that room, and on a phone the overlay stacks them under the buttons (`ios-compact:flex-col gap-5`), so the buttons were drawn ~30 pt higher than the slide's placeholder and covered the synopsis's last line. `DotsSpace` (`data-slot="marquee-dots-space"`) is the invisible rail; the actions row is the shared `heroActions` class from `hero.tsx`, used by the slide and the overlay alike (a test compares the two class lists). The phone's `feature` hero went from `min(64vh,32rem)` to `min(68vh,34rem)` for the extra room.

**Why:** the overlay only lines up with a slide if the rows it is compared against lay out identically and hold the same children, so the placeholder has to mirror the overlay, not just the visible pills.

**How to apply:** anything added to the overlay (a control, a row) needs the same in `Hero`'s `actions`/`aside`, or the next text collides with it. A 320 pt phone has 296 pt for the pills and they take 311, so `heroActions` also carries `max-[359.98px]:gap-2 [&_[data-slot=button]]:px-4`; keep `flex-wrap` on the row (no `flex-nowrap`), so a larger text size wraps instead of widening the column (that was clipping the synopsis at the right edge). Measured in WebKit ([[layout-overflow-check]]) at 393x852, 375x667, 320x568, 852x393, 1200x800 and 1440x900: no button or dash over a paragraph, nothing overflowing sideways. Related: [[hero-contrast]], [[app-shell]].
