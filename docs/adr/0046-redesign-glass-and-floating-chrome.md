---
status: accepted
date: 2026-11-05
---

# Redesign: four glass tiers in CSS, floating chrome, Apple TV × Music layout with Peli's own identity

Epic #110. On 2026-11-05 the user asked for a full visual and layout pass: posters and thumbnails at 2× (changed to 1.5× the same day), better layout everywhere (shelves, settings groupings, the player), more liquid glass, catalog chips that scroll sideways, a slightly bigger Home hero, and a rework of how the type is used (Mona Sans and Geist Mono stay). Apple TV and Apple Music on macOS 26 are the inspiration, but Peli keeps its own identity.

## What is taken from Apple, and what stays Peli's

Taken: a sidebar that floats as a glass panel inset from the window edge, big artwork (a tall billboard hero, large poster and still shelves, an Apple TV-style episode row), chrome that content scrolls under with a scroll-edge blur instead of hairlines, glass buttons over artwork (Play solid, the rest glass), settings split into panes, and a floating, rounded glass control bar in the player.

Kept: the lagoon `--brand` as the only accent (Apple's pink, red and system blue never appear), neutral grey surfaces and Nuvio's near-black dark mode (`#0A0A0B`), Mona Sans and Geist Mono (no SF Pro, no `system-ui` look), the radius scale (`--radius: 0.75rem`), the poster-first layout and the card lift on hover, and Peli's own section names (Home, Movies, Shows, Anime, Search, Library; no "Up Next" or "Watch Now").

## Four glass tiers, defined once (#111)

Tailwind utilities in `frontend/src/index.css`, so every ticket after this uses the same materials and no component hand-rolls `backdrop-blur`:

| Utility | Use | Blur / saturate | Tint (light / dark) |
|---|---|---|---|
| `glass-thin` | chips, small controls over content, row arrows | 12px / 160% | `#FFFFFF73` / `#2C2C2E73` |
| `glass` | popovers, menus, tooltips, toasts, sticky page headers | 24px / 180% | `#FFFFFFA6` / `#1C1C1EA6` |
| `glass-thick` | sidebar, sheets, dialogs, settings pane nav | 40px / 200% | `#F7F7F8C7` / `#141416C7` |
| `glass-media`, `glass-media-strong` | always dark; over artwork and video | 30px / 180% | `#00000073` (icons) / `#0000008C` (text) |

Each tier adds a soft highlight from the top, a 1px specular inner edge, a 0.5px hairline and a shadow. `--popover` becomes the regular tint, so coss's `bg-popover` matches, and coss's popups are pointed at tiers by selector. Under `prefers-reduced-transparency: reduce` every tier is a solid (`--glass-solid`, `#000000E0` for media) with no blur; under `prefers-contrast: more` it goes solid too and also gets a border (the solid part was added in #125's QA pass). Popups materialize (opacity, scale from .96 and a 6px blur) and leave the same way. `Ambient` gives a page a blurred-artwork or brand wash behind its content. The tints and their worst-case contrast are in `contrastPairs`.

## Decisions

- **CSS only, no new animation library.** Springs stay as the `--ease-spring` `linear()` curve. Motion is CSS transitions and view transitions. Peli is a pointer-and-keyboard desktop app with no flick gestures that would need velocity hand-off. Revisit only if a ticket adds drag gestures.
- **No SVG refraction filters.** `backdrop-filter: url(#…)` doesn't work in WKWebView (macOS) and is slow in WebView2, so "liquid glass" means blur, saturation, a specular edge and a soft highlight gradient.
- **Glass over video is mostly tint.** mpv draws video on a native layer under the transparent webview, so `backdrop-filter` can't blur it. The player's glass relies on the media tints, which are sized for contrast on their own: white text on `#0000008C` over a white frame composites to about `#737373` (4.7:1), white icons on `#00000073` to about `#8C8C8C` (3.4:1, UI needs 3:1). #121 checks this on the real player first.
- **No native window vibrancy.** The window background stays an opaque colour (`windowColours` in `frontend/src/lib/theme.ts` and `main.go`). The glass is all in the webview.
- **Card sizes are tokens.** The first ask was 2×; the same day the user changed it to 1.5×, so `--container-poster` goes 10rem to 15rem and `--container-landscape` 18rem to 27rem (#113). Tuning is a one-token change. Home catalog rows show 10 titles and a "Browse all" link, so long rows don't pile up big images.
- Platform order as usual: macOS first, then Windows (WebView2). Linux is deferred (#103).

## Consequences

- `backdrop-filter` costs GPU time, and it costs more on WebView2 than on WebKit. Large blurred areas (a thick sidebar over moving artwork, the player's bar over video) are what to watch. #125 measures them on Windows and falls back to a solid tier where they are too slow.
- A glass element is a backdrop root: a `backdrop-filter` inside another one (or inside anything with `filter`, `opacity` below 1 or a mask) only sees what is inside that element. So `scroll-edge-top` can't sit on an element that is itself glass, and a blurred popup that is mid-fade doesn't blur the page behind it until the fade ends.
- `--popover` is now translucent. Anything that painted `bg-popover` without a tier lost its backing: coss's outline buttons moved to `bg-card`, the skip link and the PIN panel to a tier, and the select's list to `glass`. New code uses a tier, `bg-card` or `bg-background`, not `bg-popover`.
- The hand-rolled `backdrop-blur` surfaces that remain (the player's notices, next-episode card and shortcuts overlay, the progress bar, the watched check on episodes, coss's dialog backdrops) move to tiers in the tickets that own those screens.
- The player (#121) moved its control bar, notices, resume toast, Skip button, next-episode card, shortcuts overlay, failure card and loading panel onto `glass-media` and `glass-media-strong`, so only the progress bar, the watched check and coss's dialog backdrops are left. Whether `backdrop-filter` blurs anything over the native video layer is **still unchecked in the built app**: the run that built it had no screen-capture permission (`CGPreflightScreenCaptureAccess` false, `screencapture -l` fails). The player is built so it doesn't matter: its text is plain white (muted white over the strong tint on a white frame is 3.2:1, plain white 4.7:1), its icons sit on the strong tint, and the specular edge and hairline keep the bar reading as glass without a blur. If the blur does work over video, nothing needs to change; if it doesn't, nothing is lost. Over a pure white frame the title cluster (on the `from-black/45` gradient, about 3.4:1) leans on its drop shadow.
- A glass element inside the control bar (the seek bar's time pill) is a backdrop-filter inside a backdrop-filter, so it blurs nothing of its own over the page; over video that is moot.

### What was learnt by the end of the redesign (#125)

- **Blur over video is still unverified.** The player is built so the answer doesn't matter (above), but whether `backdrop-filter` blurs anything over mpv's native layer has not been seen in the built macOS app: the runs that built it had no Screen Recording permission, so `screencapture -l` could not capture the window. Check it once in a built app with a real file playing; if it blurs, nothing changes, and if it doesn't, nothing is lost.
- **WebView2 is unverified.** Nothing has run on Windows yet: the dev-smoke workflow (`workflow_dispatch` on `windows-2025`) has not been run for the redesign, because GitHub Actions was down while the tickets were built. Still to check there: that the blur renders, that the caption buttons sit on their `glass-thin` pill, and, with no GPU on the runner, nothing about speed.
- **No blur has been reduced.** The radii are the ones in the table (thick 40px, regular 24px, media 30px, thin 12px). The fallback plan stands: if scrolling Home or the 1,000-item grid measures under about 55 fps in the built app because of the glass, lower thick to 30px first and record before and after. No such measurement has been made yet, so nothing was changed on a guess. The Browse grid at 1.5× is a memory question, not a glass one (#113: WebKit's decoded-image cache grows while scrolling, then drops on `org.WebKit.lowMemory`).
- **tailwind-merge read the new type tokens as colours.** `cn` (`lib/utils.ts`) dropped `text-title` next to `text-white`, and a `--text-card` token painted text in the card colour. The size tokens are now registered with `extendTailwindMerge` (under `theme.text`, and `text-num` under `font-family`), and the item token is `text-item`. A new `--text-*` token must be added to that list and checked against the colour names (#112).
- **The alert dialog was not on a glass tier.** The tier rules in `index.css` named `dialog-popup` and nothing else, so the alert dialog (Sign out) kept its old solid card; #122 added it to the thick tier, and its before and after are in the design README.
- **A translucent token is not a background.** `--muted` is a translucent tint, so a contrast pair that listed it alone was measured on black (the ⌘F hint read 3.53:1 in light, a fail in the gallery's live table). List translucent backgrounds with the layers under them, as `["background", "glass-regular", "muted"]` does now.
