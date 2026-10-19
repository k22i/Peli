# Design system

Cove has one theme, in light and dark (#13; theme studio is cut). The direction: **Apple's** glass and spring motion, **Vercel's** monochrome precision, **Nuvio's** poster-first, near-black cinema.

The living reference is the in-app gallery: **Settings › Design system** (`/gallery`). It shows every token and component in its states and measures contrast live.

## Where things live

| What | Where |
|---|---|
| Tokens: colour, type, spacing, radius, elevation, motion | `frontend/src/index.css` (`:root` light, `.dark` dark, the `@theme` blocks) |
| Light/dark: OS by default, System/Light/Dark override | `frontend/src/lib/theme.ts`, the inline script in `frontend/index.html`, the window colour in `main.go` |
| WCAG AA checks for every colour pairing | `frontend/src/lib/contrast.ts` (`contrastPairs`), `contrast.test.ts` |
| Base components (button, dialog, sheet, toast, skeleton, toggle, badge, menu, tooltip…) | coss ui, `frontend/src/components/ui` (add more with `pnpm dlx shadcn@4.21.4 add @coss/<name>`) |
| Cove's own: poster and landscape cards, row, hero, chip, skeletons | `frontend/src/components/media` |

## Rules of thumb

- **Colour:** surfaces are greys; the one accent is `--brand`, the "lagoon" (`#33b5e0` dark, `#0b6e94` light). Use it for focus, progress, selection and small highlights, never for large fills. coss's `--accent` is its hover tint, not the brand.
- **Contrast:** a new foreground/background pairing goes into `contrastPairs`, so the test holds it to AA (4.5:1 text, 3:1 UI) in both modes. Keep colour tokens as hex so the test can read them.
- **Over artwork, stay dark:** the hero and the progress bar scope themselves with `.dark`, since artwork is dark in either theme.
- **Type:** Mona Sans. Use `font-heading` plus `font-stretch-expanded` (display) or `font-stretch-semi-expanded` (titles, row headings) for headings, normal width for UI. Geist Mono `text-meta` for metadata (`2025 · 1h 52m`).
- **Motion:** `ease-spring` for lifts and presses, `ease-smooth` for fades and travel, durations from `--duration-fast|base|slow`. Put movement behind `motion-safe:`; reduced motion zeroes the durations.
- **Focus:** every interactive element shows a ring in `--ring` (the brand), either its own `focus-visible:ring-*` or the global `:focus-visible` outline. Cards ring their artwork. The gallery test audits this.
- **Window colour:** if `--sidebar` changes, update `windowColours` in `theme.ts` (a test checks it) and the colours in `main.go`.

## Screenshots

| | Dark | Light |
|---|---|---|
| Overview | ![](gallery-dark-top.jpg) | ![](gallery-light-top.jpg) |
| Hero | ![](gallery-dark-hero.jpg) | ![](gallery-light-hero.jpg) |
| Rows / components | ![](gallery-dark-rows.jpg) | ![](gallery-light-components.jpg) |
| Contrast | ![](gallery-dark-contrast.jpg) | |

The macOS app at launch in dark mode: ![](native-home-dark.jpg)

The gallery shots are from Chrome at 1280×800 (2×); the macOS one is the app window.
