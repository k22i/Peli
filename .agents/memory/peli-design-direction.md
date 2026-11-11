---
name: peli-design-direction
description: "The user's chosen look for Peli (Apple × Vercel × Nuvio, then the 2026-11 Apple TV × Music redesign), the lagoon brand colours and Mona Sans, and how they like design choices presented"
metadata:
  node_type: memory
  type: user
  originSessionId: df545a42-2938-4d36-87f3-16f93ac7098e
  modified: 2026-10-19T04:58:59.820Z
---

For Peli's UI the user asked for "Apple, Vercel and Nuvio had a love child" and a less generic font than Inter. Settled in #13 (2026-10-19):
- **Font:** Mona Sans (variable, width axis; wide headings) + Geist Mono for metadata.
- **Accent:** a "lagoon" cyan-blue. Their first reaction to teal (#2EC4C6) was "lean towards a little more blue", so we went to `#33B5E0` dark / `#0B6E94` light (hue ~196°). It's the `--brand` token, because coss's `--accent` is the hover tint.
- They asked for exact hex codes before agreeing, so give concrete values with WCAG contrast numbers rather than describing colours in words.

**How to apply:** new UI should extend `docs/design/README.md` and the `/gallery` page rather than inventing new colours or fonts. Related: [[frontend-stack-preferences]].

**Type (#112, 2026-11-05):** the user picked **option B · Semi-wide** from three specimens: hero and page titles at 112.5% width, row headings at 100%, body 15px, Mona Sans labels, mono only for numbers and codes. Details and the utilities: [[typography-scale]].

**The redesign (epic #110, 2026-11-05; [[redesign-epic]], ADR-0046 in `docs/adr/0046-redesign-glass-and-floating-chrome.md`):** the layout and materials are Apple TV × Apple Music on macOS 26, the identity is still Peli's.
- **Layout:** a floating `glass-thick` sidebar inset from the window edge and a title bar strip, with the content pane scrolling under both (`bleed` lets art run under them); a tall billboard hero; 1.5× cards (15rem posters, 27rem stills; first asked 2×, changed the same day); one-line `ScrollRail`/`ChipRail` instead of wrapping chips; settings in panes; a floating `glass-media-strong` capsule in the player; Play solid with every other button over art in glass.
- **Identity rules (don't copy Apple here):** the lagoon `--brand` is the only accent (no Apple pink, red or system blue); neutral greys and Nuvio's near-black dark mode; Mona Sans + Geist Mono (no SF Pro, no `system-ui` look); the `--radius: 0.75rem` scale, poster-first layout and card lift; Peli's section names (no "Up Next", "Watch Now").
- **Tiers:** `glass-thin` 12px, `glass` 24px, `glass-thick` 40px, `glass-media` / `-strong` 30px (always dark). One definition in `index.css`; never hand-roll `backdrop-blur`. Solid under reduced transparency, bordered under increased contrast. Over video it is mostly tint (mpv is a native layer under the webview). See [[glass-materials]].
- **Type, option B (#112):** the user chose it from three specimens. `text-display` / `text-title` at 112.5% width, `text-heading`, `text-body` 15px, `text-item`, `text-caption`, `text-label` (Mona Sans uppercase), `text-num` (mono, numbers and codes only). See [[typography-scale]].
- **Motion (#124):** CSS only; press scale 0.97, sliding nav and settings pills, `data-nav` forward/back/section page transitions, all off under reduced motion. See [[motion]].
- **Not yet verified** (as of #125's docs run): blur over video in the built app, WebView2 on Windows, and any blur-radius reduction (none made). The ADR's Consequences keep the list.
- The system is written up in `docs/design/README.md` (rules first, then a record per ticket) and shown live at `/gallery` ([[gallery-and-design-docs]]).

**Logo (2026-11-11, ADR-0052):** the user picked option A from three pelican sketches (play button / pelican / pelican carrying a play button), then asked for "more character" like the Rex terminal's icon (chunky, a bumpy frill, a slot eye, glossy warm gradient). The result is `PeliMark`: the play triangle is the bill and pouch, with a big round head, a curly crest, a scalloped nape, a slot eye and a cut bill line. The app icon is that pelican in cream on an amber tile (they chose amber over dark and paper); its source is `build/appicon.svg`. A hooked bill tip read as a drip and was dropped. They like to choose from rendered options, so show a sheet of options rather than describing them.
