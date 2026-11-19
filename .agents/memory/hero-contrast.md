---
name: hero-contrast
description: "Hero text contrast (2026-11-19): measured text-column shade, lib/art-tone canvas sampling (CORS per host), white eyebrow + sun dot, dark-logo silhouette, textless TMDB backdrop, desktop shot rig"
metadata:
  type: project
---

`components/media/hero.tsx` shades behind the text column, not from the window corner: a left-to-right gradient (85 % → 55 % at `--text-x` + 38rem, gone by max(60 %, +50rem)), plus a bottom gradient. On the phone (`useCompactShell`) the shade comes from the bottom instead. A second "bright" layer (+50 %) fades in over bright art, or while the art is unread or unreadable. Small text is `text-white/90` with a faint text shadow; the eyebrow is white with a `bg-sun` dot (it was amber #ffc46b). A logo whose opaque pixels are mostly near-black is shown as a white silhouette (`brightness-0 invert`, `data-silhouette`). `lib/tmdb.ts` `textlessBackdrop` picks a backdrop with `iso_639_1` null/"xx" over `backdrop_path`.

**Why:** behind the eyebrow and title the old radial scrim was ~35 % black, so the small text failed on bright art and dark logos vanished.

**How to apply:**
- `lib/art-tone.ts`: `useArtTone(url, "backdrop"|"logo")` draws a small copy (TMDB w300/w185, Metahub `small`) on a 48-px canvas and caches the luminance grid per URL. `undefined` means still reading and `null` means it can't be read. Callers treat both as bright. The hero measures its text column (`useTextRegion`) and `regionTone` maps that onto the `object-cover` crop. Thresholds (`brightMean`, `brightP90`, `darkLogo*`) are tied to the "Hero text …" pairs in `lib/contrast.ts`.
- CORS, checked 2026-11-19: image.tmdb.org, images/live.metahub.space, artworks.thetvdb.com and assets.fanart.tv send `*`. media.kitsu.app sends none. s4.anilist.co echoes only http(s) origins, not `wails://`, so anime art gets the strong fixed shade. If that matters, a Go-side sample is the next step.
- Never set `crossOrigin` on the visible `<img>`: Kitsu art would stop loading. The sampler uses its own `Image`.
- Shot rig: a component-only entry in `frontend/.shot/` (excluded in `.git/info/exclude`) with a config whose `root` is `frontend/`, react + tailwind and `@` → `src`. It renders `Hero` with live Cinemeta metas, shot by headless Chrome over CDP. Load each page once before shooting, because Vite's first dependency optimisation reloads the page and the first shots come out blank. Test art: Barbie/Truman Show (bright), The Batman/Falcon & Winter Soldier (dark), Se7en/Dune (dark logo).
- Related: [[home-hero]], [[title-page-redesign]], [[peli-design-direction]].
