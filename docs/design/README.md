# Design system

Sinag has one theme, in light and dark (#13; theme studio is cut). The direction: **Apple's** glass and spring motion, **Vercel's** monochrome precision, **Nuvio's** poster-first, near-black cinema.

The living reference is the in-app gallery: **Settings › Design system** (`/gallery`). It shows every token and component in its states and measures contrast live.

## Where things live

| What | Where |
|---|---|
| Tokens: colour, type, spacing, radius, elevation, motion | `frontend/src/index.css` (`:root` light, `.dark` dark, the `@theme` blocks) |
| Light/dark: OS by default, System/Light/Dark override | `frontend/src/lib/theme.ts`, the inline script in `frontend/index.html`, the window colour in `main.go` |
| WCAG AA checks for every colour pairing | `frontend/src/lib/contrast.ts` (`contrastPairs`), `contrast.test.ts` |
| Base components (button, dialog, sheet, toast, skeleton, toggle, badge, menu, tooltip…) | coss ui, `frontend/src/components/ui` (add more with `pnpm dlx shadcn@4.21.4 add @coss/<name>`) |
| Sinag's own: poster and landscape cards, row, hero, chip, skeletons | `frontend/src/components/media` |

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

### Welcome and sign-in (#20)

First run, in the macOS app: ![](native-welcome-dark.jpg)

| | |
|---|---|
| No keychain (Linux without a Secret Service) | ![](welcome-no-keychain-light.jpg) |
| Wrong password | ![](sign-in-wrong-password-dark.jpg) |
| Network down | ![](sign-in-network-down-light.jpg) |
| Rate limited | ![](sign-in-rate-limited-dark.jpg) |
| Nuvio returns a server error | ![](sign-in-nuvio-down-light.jpg) |

These are from Chrome at 1000×618 (2×), with the Go services stubbed. Before there's a profile, the screens use the `focus` chrome: the title bar only, no sidebar.

### Signing out and ended sessions (#22)

| | |
|---|---|
| Signed in: Settings offers Sign out | ![](settings-signed-in-light.jpg) |
| Sign out asks first | ![](sign-out-dialog-dark.jpg) |
| The session ended (revoked or expired): at launch, or as soon as Go notices | ![](sign-in-session-ended-dark.jpg) |
| After "Not now": the profile menu offers Sign in again | ![](menu-session-ended-dark.jpg) |
| …and so does Settings, which still offers Sign out to remove the account's data | ![](settings-session-ended-light.jpg) |

Chrome at 1000×618 (2×), with the Go services stubbed.

### Guest mode (#23)

| | |
|---|---|
| First run: the welcome screen says what a guest keeps and that the Guest stays as it is | ![](welcome-guest-light.jpg) |
| A guest's profile menu offers Sign in to Nuvio instead of Sign out | ![](menu-guest-dark.jpg) |
| Signing in from the Guest: its profile stays apart from the account's ([ADR-0010](../adr/0010-guest-data-stays-apart.md)) | ![](sign-in-guest-dark.jpg) |

Chrome at 1000×618 (2×), with the Go services stubbed.

### Profile picker (#24)

| | |
|---|---|
| At launch with more than one profile: the last one used is focused, and Nuvio's avatars show on their colours | ![](profiles-dark.jpg) |
| Offline, or before an image loads: initials on the profile's colour, the Guest on the lagoon brand ([ADR-0011](../adr/0011-profile-avatars-and-picker.md)) | ![](profiles-offline-light.jpg) |
| The profile menu switches in place | ![](menu-switch-profile-dark.jpg) |
| Settings › Profiles opens the picker | ![](settings-profiles-light.jpg) |
| The picker removes the Guest after asking | ![](profiles-remove-guest-dark.jpg) |
| A guest on their own: the picker offers to sign in | ![](profiles-guest-only-light.jpg) |

Chrome at 1000×618 (2×), with the Go services stubbed. Avatar images are Nuvio's, from its public catalog.
