# Design system

Sinag has one theme, in light and dark (#13; theme studio is cut). The direction: **Apple's** liquid glass (four tiers, below) and spring motion, **Vercel's** monochrome precision, **Nuvio's** poster-first, near-black cinema.

The living reference is the in-app gallery: **Settings › Design system** (`/gallery`). It shows every token and component in its states and measures contrast live.

## Where things live

| What | Where |
|---|---|
| Tokens: colour, type, spacing, radius, elevation, motion | `frontend/src/index.css` (`:root` light, `.dark` dark, the `@theme` blocks) |
| Light/dark: OS by default, System/Light/Dark override | `frontend/src/lib/theme.ts`, the inline script in `frontend/index.html`, the window colour in `main.go` |
| WCAG AA checks for every colour pairing | `frontend/src/lib/contrast.ts` (`contrastPairs`), `contrast.test.ts` |
| Base components (button, dialog, sheet, toast, skeleton, toggle, badge, menu, tooltip…) | coss ui, `frontend/src/components/ui` (add more with `pnpm dlx shadcn@4.21.4 add @coss/<name>`) |
| Glass tiers, scroll edge, materialize motion | `frontend/src/index.css` (`@utility glass-*`, `scroll-edge-top`); `Ambient` in `frontend/src/components/media/ambient.tsx` |
| Sinag's own: poster and landscape cards, row, poster grid, hero, chip, skeletons | `frontend/src/components/media` (rows and grids are virtualized, ADR-0025) |

## Rules of thumb

- **Colour:** surfaces are greys; the one accent is `--brand`, the "lagoon" (`#33b5e0` dark, `#0b6e94` light). Use it for focus, progress, selection and small highlights, never for large fills. coss's `--accent` is its hover tint, not the brand.
- **Contrast:** a new foreground/background pairing goes into `contrastPairs`, so the test holds it to AA (4.5:1 text, 3:1 UI) in both modes. Keep colour tokens as hex so the test can read them.
- **Glass:** pick a tier (below); don't hand-roll `backdrop-blur`. Never stack a light tier on another light tier. Over artwork or video use `glass-media` (icons) or `glass-media-strong` (text), which stay dark in both themes.
- **Over artwork, stay dark:** the hero and the progress bar scope themselves with `.dark`, since artwork is dark in either theme.
- **Type:** Mona Sans. Use `font-heading` plus `font-stretch-expanded` (display) or `font-stretch-semi-expanded` (titles, row headings) for headings, normal width for UI. Geist Mono `text-meta` for metadata (`2025 · 1h 52m`).
- **Motion:** `ease-spring` for lifts and presses, `ease-smooth` for fades and travel, durations from `--duration-fast|base|slow`. Put movement behind `motion-safe:`; reduced motion zeroes the durations.
- **Long lists:** use `Row` (inside a `RowGroup` when rows stack) and `PosterGrid`, which mount only the cards near the viewport, rather than mapping cards into a flex row. Gallery › Long rows has a 200-poster row, a 1,000-poster grid and a scroll test.
- **Focus:** every interactive element shows a ring in `--ring` (the brand), either its own `focus-visible:ring-*` or the global `:focus-visible` outline. Cards ring their artwork. The gallery test audits this.
- **Window colour:** it is `--background`, because the content pane fills the window and the glass sidebar floats over it. If `--background` changes, update `windowColours` in `theme.ts` (a test checks it) and the colours in `main.go`.

## Glass

Defined once in `index.css` (#111, [ADR-0046](../adr/0046-redesign-glass-and-floating-chrome.md)). A tier is a tint, a blur and saturation, a soft highlight from the top, a 1px specular inner edge, a 0.5px hairline and a shadow. Use it as a class (`glass-thick`, `md:glass`, `hover:glass-thin`).

| Utility | Use | Blur / saturate | Tint (light / dark) |
|---|---|---|---|
| `glass-thin` | chips, small controls over content, row arrows | 12px / 160% | `#FFFFFF73` / `#2C2C2E73` |
| `glass` (also the old `.glass`) | popovers, menus, tooltips, toasts, sticky page headers | 24px / 180% | `#FFFFFFA6` / `#1C1C1EA6` |
| `glass-thick` | sidebar, sheets, dialogs, settings pane nav | 40px / 200% | `#F7F7F8C7` / `#141416C7` |
| `glass-media` | always dark; icons over artwork and video | 30px / 180% | `#00000073` |
| `glass-media-strong` | the same, when it holds text | 30px / 180% | `#0000008C` |

- **Tokens:** `--glass-thin|regular|thick|media|media-strong` (tints), `--glass-edge`, `--glass-stroke`, `--glass-sheen`, `--glass-solid` (the fallback). `--popover` is the regular tint, so coss's `bg-popover` matches. coss's menus, selects, tooltips and toasts sit on the regular tier, and dialogs and sheets on thick, by selector in `index.css`.
- **Over video, glass is mostly tint.** mpv draws on a native layer under the webview, so `backdrop-filter` can't blur it. The media tints are sized for contrast on their own: white text on `#0000008C` over a white frame is 4.7:1, white icons on `#00000073` 3.4:1 (`contrastPairs` holds both).
- **Fallbacks.** Under `prefers-reduced-transparency: reduce` every tier turns into `--glass-solid` (`#000000E0` for media) with no blur or highlight; under `prefers-contrast: more` it also gets a 1px border. `reduced-transparency:` is a Tailwind variant for the same condition, and the gallery's toggle sets `data-transparency="reduced"` to show it. Support for the media feature varies by engine, so check it with CDP: `Emulation.setEmulatedMedia({ features: [{ name: "prefers-reduced-transparency", value: "reduce" }] })`.
- **Scroll edge.** `scroll-edge-top` on a sticky or fixed header adds a 24px strip below it that blurs and washes out what scrolls past. Don't put it on an element that has a glass tier: a `backdrop-filter` makes its element a backdrop root, and the strip inside it would have nothing to blur. Use a wrapper.
- **Materialize.** coss popups arrive and leave with opacity, a scale from .96 and a 6px blur (`--duration-base`, `ease-smooth`); sheets skip the scale. Reduced motion keeps opacity only.
- **Ambient.** `<Ambient src tone="art" | "brand" />` is a tall wash behind a page's content: the page's artwork blurred to a haze, or two pools of `--brand`. The parent needs `relative isolate`. With no `src` the art tone shows the brand glow.

Not done on purpose: SVG refraction (`backdrop-filter: url()` doesn't work in WKWebView and is slow in WebView2), native window vibrancy, and a motion library.

## Shell

The shell (#114, `components/shell/`) is the app window's frame. The content pane (`#content`) fills the whole window and scrolls **under** two pieces of chrome: a floating `glass-thick` sidebar (a 15rem panel inset 0.5rem from the edges; a 4rem icon rail below `md`) and a title bar strip that is empty until the page is scrolled 4px, then shows `scroll-edge-top`. The shell root sets two variables, and the pane pads itself by them, so a page needs nothing:

- `--sidebar-inset`: the room the sidebar takes (`calc(15rem + 1rem)` from `md`, `calc(4rem + 1rem)` below).
- `--titlebar-h`: `2.75rem` on macOS, `2rem` on Windows, `0px` elsewhere (Linux keeps its native frame).

Full-bleed artwork (the Home and title heroes, #115 and #117) uses the `bleed` utility, which cancels both paddings so the art runs under the glass. Text on it offsets itself with `ps-[calc(var(--sidebar-inset)+var(--spacing-gutter))]`. Gallery › Shell has a sample.

The sidebar lists Search (a field-like link, `⌘F`), Home, Movies, Shows, Anime, then Library. That is only how it looks: ⌘/Ctrl+1–6 still follow `sections.ts`, and the arrow keys follow what is on screen. The active item is `bg-brand-soft` with a brand icon. On macOS the panel keeps `pt-11` free for the traffic lights, which sit in its top-left corner. On Windows the caption buttons sit top-right on a `glass-thin` pill. Under reduced transparency the panel is the solid `--glass-solid`.

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

### QR sign-in (#21)

| | |
|---|---|
| Waiting: the QR code opens nuvio.tv/link with the code filled in; the short code is for typing there on any device, and the countdown runs to the 5-minute expiry ([ADR-0013](../adr/0013-qr-sign-in-via-nuvio-link.md)) | ![](qr-waiting-dark.jpg) |
| Expired: one click for a new code | ![](qr-expired-light.jpg) |
| Couldn't start (offline): the sign-in errors, with Try again | ![](qr-error-light.jpg) |

The QR is black modules on a white tile in both themes (21:1), because phone cameras read dark on light best. Chrome at 1000×680 (2×), with the Go services stubbed.

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

### Managing profiles (#95)

| | |
|---|---|
| **Manage profiles** in the picker, the profile menu or Settings › Profiles: a pencil badge on each tile, and **Add profile** while the account has a free slot | ![](profiles-manage-dark.jpg) |
| Editing a Nuvio profile: name, one of Nuvio's stock avatars (picking one takes the colour it was drawn for) and a colour. **Delete** isn't offered for the primary or the last profile ([ADR-0012](../adr/0012-profile-changes-go-to-nuvio-first.md)) | ![](profile-edit-light.jpg) |
| Adding a profile | ![](profile-add-dark.jpg) |
| Deleting says the profile goes from every device | ![](profile-delete-dark.jpg) |
| Offline: the change is refused, not queued, and the editor stays open with the error up top | ![](profile-offline-light.jpg) |
| All six Nuvio profiles in use | ![](profiles-full-light.jpg) |

Colours, with the initials colour picked for contrast: `#33B5E0` (black, 8.3:1), `#1E88E5` (black, 5.4), `#7957BD` (white, 5.4), `#D81B60` (white, 4.9), `#E53935` (black, 4.7), `#FB8C00` (black, 8.3), `#FDD835` (black, 14.2), `#43A047` (black, 6.0), `#00897B` (black, 4.6), `#546E7A` (white, 5.4). A colour set elsewhere (Nuvio takes any) is offered first. The Guest is renamed only, and stays on the lagoon brand.

Chrome at 1280×800 (2×), with the Go services stubbed. Avatar images are Nuvio's stock avatars, from a local self-host stack's catalog.

### Stream picker (#52)

| | |
|---|---|
| The top pick, played with **P**, then groups by quality; each stream told by its badges ([ADR-0036](../adr/0036-stream-picker.md)). Live answers from Torrentio and Peerflix, no debrid | ![](stream-picker-dark.jpg) |
| A file name, shown only on request (the File name button, or **I**) | ![](stream-picker-file-name-light.jpg) |
| Gallery › Stream picker: cached on debrid (brand, with a bolt), not cached, and P2P | ![](stream-picker-gallery-light.jpg) |

Chrome at 1280×800 (2×), with the Go services stubbed. The top pick's border and "Top pick" are `--brand` on `--card` (checked in `contrastPairs`).

### Glass materials (#111)

| | |
|---|---|
| Gallery › Materials, dark: each tier over a busy image and over the page, the two Ambient tones, and a scroll edge | ![](glass-materials-dark.jpg) |
| …and light | ![](glass-materials-light.jpg) |
| With "Reduced transparency" on: every tier is solid | ![](glass-materials-reduced-dark.jpg) |
| The scroll edge, scrolled (light) | ![](glass-scroll-edge-light.jpg) |
| A dialog (thick tier) over a busy image, before and after, dark | ![](glass-dialog-dark-before-after.jpg) |
| …light | ![](glass-dialog-light-before-after.jpg) |
| A menu (regular tier), before and after, dark | ![](glass-menu-dark-before-after.jpg) |
| …light | ![](glass-menu-light-before-after.jpg) |

Chrome at 1280×800 and 1000×618 (2×); the dialog and menu pairs show the old look on the left. The shots come from a throwaway page that renders the gallery's Materials section and the coss dialog and menu, since the full app needs the Go services.

### Type specimens (#112)

| | |
|---|---|
| A · Calm: 100% width, weight 720 display, Mona Sans labels | ![](type-specimen-A-dark.jpg) |
| B · Semi-wide: 112.5% display and page titles (recommended) | ![](type-specimen-B-dark.jpg) |
| C · Marquee: 125% heavy hero, mono eyebrows | ![](type-specimen-C-dark.jpg) |

Dark, 1280 wide (2×). Gallery › Type specimens has the switch; the sample block holds a hero, a row with two captioned posters, a title-page block, a settings row and a player time readout. The shots come from a throwaway page that renders that block, since the full app needs the Go services. Once an option is picked, the Type rule above changes to match.

### Cards at 1.5× (#113)

| | Before | After |
|---|---|---|
| Home rows, dark | ![](cards-home-dark-before.jpg) | ![](cards-home-dark-after.jpg) |
| Home rows, light | ![](cards-home-light-before.jpg) | ![](cards-home-light-after.jpg) |
| Browse grid, dark | ![](cards-browse-dark-before.jpg) | ![](cards-browse-dark-after.jpg) |
| Browse grid, light | ![](cards-browse-light-before.jpg) | ![](cards-browse-light-after.jpg) |

Chrome at 1280×800 (2×). Posters are 15rem wide and landscape cards 27rem (`--container-poster`, `--container-landscape`; `cardRem` in `row.tsx` follows). The art is real: the recorded Cinemeta fixtures' Metahub posters and backdrops, and the after shots go through `lib/artwork-url.ts` (small → medium). The shots come from a throwaway page with a `Row` and a `PosterGrid`, not the full app, which needs the Go services. The title page's episode list isn't shown: it needs the store.

### Shell (#114)

| | Before | After |
|---|---|---|
| Home, dark | ![](shell-home-dark-before.jpg) | ![](shell-home-dark-after.jpg) |
| Home, light | ![](shell-home-light-before.jpg) | ![](shell-home-light-after.jpg) |
| Scrolled, dark | ![](shell-scrolled-dark-before.jpg) | ![](shell-scrolled-dark-after.jpg) |
| Scrolled, light | ![](shell-scrolled-light-before.jpg) | ![](shell-scrolled-light-after.jpg) |

| | |
|---|---|
| Icon rail below `md` (720×700), dark | ![](shell-rail-dark.jpg) |
| …light | ![](shell-rail-light.jpg) |
| 900×700 keeps the full panel (`md` is 768), dark | ![](shell-narrow-dark.jpg) |
| Windows: caption buttons on a glass pill, scrolled | ![](shell-windows-dark.jpg) |
| Settings in the new shell (its nav sticks below the title bar) | ![](shell-settings-dark.jpg) |
| The built macOS app on the welcome screen (focus chrome): traffic lights at the top-left, the window painted `--background` | ![](shell-native-welcome-dark.jpg) |

Chrome at 1280×800 (2×) with the Go services stubbed (real Cinemeta posters), and the platform forced to macOS or Windows. The scrolled shots show the title bar's scroll edge over the first row. The Home hero does not run under the glass yet: it uses `bleed` in #115.

### Home hero and shelves (#115)

| | Before | After |
|---|---|---|
| 1280×800, dark | ![](hero-home-dark-1280-before.jpg) | ![](hero-home-dark-1280-after.jpg) |
| 1280×800, light | ![](hero-home-light-1280-before.jpg) | ![](hero-home-light-1280-after.jpg) |
| 1728×1080, dark | ![](hero-home-dark-1728-before.jpg) | ![](hero-home-dark-1728-after.jpg) |
| 1728×1080, light | ![](hero-home-light-1728-before.jpg) | ![](hero-home-light-1728-after.jpg) |

| | |
|---|---|
| Shelves scrolled into view, dark: Continue watching with the episode pill and time left, "Browse all ›" at the heading's end | ![](hero-shelves-dark-after.jpg) |
| …light | ![](hero-shelves-light-after.jpg) |

Chrome at 2× with the Go services stubbed (real Cinemeta catalogs and Metahub art; three Continue watching entries and a library made up in the stub). The feature hero is `min-h-[min(80vh,46rem)]`, full-bleed in both themes, with a 8rem fade (`--fade` is the page colour, resolved outside the `.dark` scope) that sits under the text.

### Chip rail and sticky Browse header (#116)

| | Before | After |
|---|---|---|
| Movies with 50 catalogs, dark (the 40th is selected) | ![](rail-browse-dark-before.jpg) | ![](rail-browse-dark-after.jpg) |
| …light | ![](rail-browse-light-before.jpg) | ![](rail-browse-light-after.jpg) |
| Stream picker with 12 addons, dark | ![](rail-picker-dark-before.jpg) | ![](rail-picker-dark-after.jpg) |

| | |
|---|---|
| Browse scrolled: the header sticks as a glass strip, the title steps down, dark | ![](rail-browse-stuck-dark.jpg) |
| …light | ![](rail-browse-stuck-light.jpg) |
| Pointer over the rail: glass arrows at both ends, dark | ![](rail-browse-hover-dark.jpg) |
| …light | ![](rail-browse-hover-light.jpg) |
| Stream picker, light (an addon in error keeps Try again) | ![](rail-picker-light-after.jpg) |
| Library, dark (three type chips fit, so no arrows or fades) | ![](rail-library-dark.jpg) |
| …light | ![](rail-library-light.jpg) |
| Gallery › Components: `ChipRail` with 50 chips | ![](rail-gallery-dark.jpg) |

Chrome at 1280×800 (2×) with the Go services stubbed. A local server stood in for the addons: one with 50 movie catalogs (Cinemeta data) and 12 stream addons, one of which answers 503 and one that is still pending.

### Settings panes (#120)

| | Before | After |
|---|---|---|
| Account, dark (before: the top of one long page with a table of contents) | ![](settings-before-account-dark.jpg) | ![](settings-pane-account-dark.jpg) |
| Account, light | ![](settings-before-account-light.jpg) | ![](settings-pane-account-light.jpg) |
| Playback, dark (before: the Playback section scrolled into view, with Subtitles and the torrent rows in the same list) | ![](settings-before-playback-dark.jpg) | ![](settings-pane-playback-dark.jpg) |

| | |
|---|---|
| Playback, light | ![](settings-pane-playback-light.jpg) |
| Addons & content, dark | ![](settings-pane-content-dark.jpg) |
| Languages & subtitles, dark | ![](settings-pane-languages-dark.jpg) |
| Streaming, dark (torrent streaming on, so the cache row shows) | ![](settings-pane-streaming-dark.jpg) |
| Tracking, dark (SIMKL connected, AniList not; the lead paragraph is the old "SIMKL and AniList" row) | ![](settings-pane-tracking-dark.jpg) |
| Appearance, dark | ![](settings-pane-appearance-dark.jpg) |
| Privacy, dark | ![](settings-pane-privacy-dark.jpg) |
| About, dark | ![](settings-pane-about-dark.jpg) |
| Narrow window (640×900), dark: the pane list becomes a chip rail | ![](settings-pane-narrow-dark.jpg) |
| …light | ![](settings-pane-narrow-light.jpg) |

Chrome at 1280×800 (2×) with the Go services stubbed; the narrow shots are 640×900. The pane list is `SettingsPaneList` (`components/settings/settings-section.tsx`): icon tiles, a `data-settings-pill` element behind the current item, arrow keys with a single Tab stop. Below `md` it is a `ChipRail`.

### Player: floating glass control bar (#121)

The two full-width gradient strips became a rounded `glass-media-strong` capsule along the bottom (elapsed, seek bar, remaining; volume at the start, Back 10 / Play / Forward 10 in the centre, the menus at the end), a title cluster with a glass Back button, and strong media glass for every overlay. The player has one look in both themes (everything is `dark`), so only the first shot has a light twin.

| | Before | After |
|---|---|---|
| Controls up over a frame | ![](player-controls-before.jpg) | ![](player-controls-after.jpg) |
| …over a white frame (the worst case; Back was invisible before) | ![](player-bright-before.jpg) | ![](player-bright-after.jpg) |
| Subtitles menu open | ![](player-menu-subtitles-before.jpg) | ![](player-menu-subtitles-after.jpg) |
| Next-episode card | ![](player-next-episode-before.jpg) | ![](player-next-episode-after.jpg) |
| Resume toast, Skip intro and a notice | ![](player-overlays-before.jpg) | ![](player-overlays-after.jpg) |
| Shortcuts overlay | ![](player-shortcuts-before.jpg) | ![](player-shortcuts-after.jpg) |
| Failure card | ![](player-failure-before.jpg) | ![](player-failure-after.jpg) |
| Mini player (480×270) | ![](player-mini-before.jpg) | ![](player-mini-after.jpg) |

| | |
|---|---|
| Controls, light colour scheme (the same) | ![](player-controls-light-after.jpg) |
| Audio menu | ![](player-menu-audio-after.jpg) |
| Pointer over the seek bar: the track has grown, glass time pill | ![](player-seek-hover-after.jpg) |
| Space pressed: the centre mark, 30 ms in (it fades out over 450 ms) | ![](player-flash-after.jpg) |
| Buffering panel | ![](player-loading-after.jpg) |

Chrome at 1280×800 (2×) with the Go services stubbed (real Cinemeta art and episode details; a made-up Torrentio answer for the next episode). Over the real player the video is a native layer under the transparent webview, so `backdrop-filter` is expected to blur nothing there: the shots switch it off (`backdrop-filter: none`) and show the tints alone, which is what the player's text contrast is sized for. The frame behind is a Metahub backdrop, and a white gradient for the bright shot. **Not captured:** the built macOS app over real video. This run had no screen-capture permission, so whether blur really does nothing over the video is still to be confirmed (see ADR-0046).

Notes from the shots: text inside the bar and the strong-glass overlays is plain white, not `white/70`: muted white over strong glass over a white frame is 3.2:1, plain white 4.7:1. The title cluster sits on the lighter top gradient only (`from-black/45`); over a pure white frame the title is about 3.4:1 and relies on its drop shadow.

### Stream picker, Addons page and popups (#122)

| | Before | After |
|---|---|---|
| Stream picker, dark | ![](picker-dark-before.jpg) | ![](picker-dark-after.jpg) |
| Stream picker, light | ![](picker-light-before.jpg) | ![](picker-light-after.jpg) |
| Addons, dark | ![](addons-dark-before.jpg) | ![](addons-dark-after.jpg) |
| Addons, light | ![](addons-light-before.jpg) | ![](addons-light-after.jpg) |
| Dialog (Install an addon), dark | ![](popups-dialog-dark-before.jpg) | ![](popups-dialog-dark-after.jpg) |
| Menu with a submenu (profile menu › Switch profile), dark | ![](popups-submenu-dark-before.jpg) | ![](popups-submenu-dark-after.jpg) |
| Profile menu, dark | ![](popups-profile-menu-dark-before.jpg) | ![](popups-profile-menu-dark-after.jpg) |
| Toast (Removed … with Undo), dark | ![](popups-toast-dark-before.jpg) | ![](popups-toast-dark-after.jpg) |
| Alert dialog (Sign out), dark | ![](popups-alert-dark-before.jpg) | ![](popups-alert-dark-after.jpg) |

| | |
|---|---|
| Picker scrolled: the quality heading stays under the title bar on glass, dark | ![](picker-stuck-dark-after.jpg) |
| …light | ![](picker-stuck-light-after.jpg) |
| Picker for an episode: the title with its episode line under it, dark | ![](picker-episode-dark-after.jpg) |
| Addon row menu, dark | ![](popups-row-menu-dark-after.jpg) |
| Dialog, light | ![](popups-dialog-light-after.jpg) |
| Menu with a submenu, light | ![](popups-submenu-light-after.jpg) |
| Profile menu, light | ![](popups-profile-menu-light-after.jpg) |
| Toast, light | ![](popups-toast-light-after.jpg) |
| Alert dialog, light | ![](popups-alert-light-after.jpg) |

Chrome at 1280×800 (2×) with the Go services stubbed (real Cinemeta meta and art), and a local server standing in for two stream addons (a debrid one and a peer-to-peer one) with made-up releases for the film and an episode. The "before" shots come from the starting commit, the same rig. The picker shows each stream as its quality and source in the row's own name, the addon muted after it, neutral badges, and size and languages in mono at the end; only "Cached" keeps the brand. The alert dialog was not on a glass tier before (the tier rules named only `dialog-popup`), which the before shot shows.

### Welcome, sign-in, QR, profile picker and PIN screens (#123)

The screens before a profile is in use (the `focus` chrome) sit on `Ambient tone="brand"`: the lagoon glow, pulled up under the title bar's strip by `FocusScreen` (`components/account/focus-screen.tsx`), which also centres the content. Forms are `glass-thick` cards (`max-w-md rounded-3xl p-8`) with `h-11 rounded-xl` fields; big actions are pills: the main one solid, the others `glass` (`pillButton` and `glassButton` in the same file). The picker's avatars are `size-32` (`md:size-36`) on `w-40` tiles that lift to 1.05× with `ease-spring` on hover and focus (a brand ring on focus), and the pencil badge is a `glass` circle. PIN keys are `size-16 rounded-full glass-thin` with digits at `text-heading`; four `size-3.5` dots fill with `bg-foreground`, and shake with the toast-error keyframes on a wrong PIN (none under reduced motion).

| | Before | After |
|---|---|---|
| Welcome, dark | ![](welcome-dark-before.jpg) | ![](welcome-dark.jpg) |
| Welcome, light (the guest note) | ![](welcome-guest-light-before.jpg) | ![](welcome-guest-light.jpg) |
| Sign-in, wrong password, dark | ![](sign-in-wrong-password-dark-before.jpg) | ![](sign-in-wrong-password-dark.jpg) |
| QR waiting, dark | ![](qr-waiting-dark-before.jpg) | ![](qr-waiting-dark.jpg) |
| Who's watching, dark | ![](profiles-dark-before.jpg) | ![](profiles-dark.jpg) |
| Manage profiles, dark | ![](profiles-manage-dark-before.jpg) | ![](profiles-manage-dark.jpg) |
| Profile editor, light | ![](profile-edit-light-before.jpg) | ![](profile-edit-light.jpg) |
| Wrong PIN, dark | ![](pin-wrong-dark-before.jpg) | ![](pin-wrong-dark.jpg) |

| | Dark | Light |
|---|---|---|
| Sign-in | ![](sign-in-guest-dark.jpg) (with a Guest on the device) | ![](sign-in-light.jpg) |
| QR waiting: the tile stays black on white | ![](qr-waiting-dark.jpg) | ![](qr-waiting-light.jpg) |
| QR expired | ![](qr-expired-dark.jpg) | ![](qr-expired-light.jpg) |
| Who's watching | ![](profiles-dark.jpg) | ![](profiles-light.jpg) |
| Manage profiles | ![](profiles-manage-dark.jpg) | ![](profiles-manage-light.jpg) |
| Profile editor (avatars at `size-16`) | ![](profile-edit-dark.jpg) | ![](profile-edit-light.jpg) |
| Enter PIN, two digits in | ![](pin-entry-dark.jpg) | ![](pin-entry-light.jpg) |
| Welcome | ![](welcome-dark.jpg) | ![](welcome-guest-light.jpg) |

Every screenshot in the #20–#24 and #95 sections above has been re-taken under the same file name, apart from the ones that are another screen's: `native-welcome-dark.jpg` (the built app), the profile-menu shots (`menu-*`, #122) and the Settings ones (`settings-*`, #120). The sign-in shots are 1280×900 and the session-ended one 1280×1040, since the card is taller than the window; the rest are 1280×800 (2×). They come from a throwaway Vite config with the Go services stubbed and the platform forced to macOS, so the title bar is the real overlay strip. The avatars are drawn for the shots (simple faces on Nuvio's colours), not Nuvio's stock catalog, which needs its key. Contrast: the PIN key digits over thin-on-thick glass are in `contrastPairs` (14.5:1 and 9.5:1 in dark, 13.0 and 17.2 in light over black and white); muted text over the brightest point of the brand glow (brand at 18% over the page) is 5.9:1 in dark and 4.6:1 in light.
