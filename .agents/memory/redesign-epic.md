---
name: redesign-epic
description: "Redesign epic #110 (2026-11-05): Apple TV × Music layout with Sinag's own identity, more liquid glass, 2× cards, type rework keeping both fonts; sub-tickets #111–#125"
metadata:
  type: project
---

On 2026-11-05 the user asked for a total redesign: more liquid glass, posters and thumbnails at 2×, better layout everywhere (rows, settings groupings, player), Browse catalog chips that scroll sideways instead of wrapping, and a slightly bigger Home hero. Epic #110 (M3, P0, `area:design`), with sub-tickets #111–#125 on the Sinag Roadmap board.

- **Inspiration:** Apple TV and Apple Music (floating glass sidebar, full-bleed art, shelves, a floating player bar), **but Sinag keeps its own identity**: the lagoon `--brand` as the only accent, Nuvio near-black dark mode, its radius scale, and its section names.
- **Fonts:** the user dislikes the current type, yet said "keep Mona Sans" and "Geist Mono is also ok". So #112 changes usage only (widths, weights, sizes, where mono appears) and waits for them to pick specimen A, B or C.
- **Glass:** four tiers (`glass-thin`, `glass`, `glass-thick`, `glass-media`) defined in #111 and ADR-0046. CSS only (no SVG refraction, no motion library, no native vibrancy). Over video it's mostly tint, because mpv draws on a native layer under the webview.

**Why:** the user wants tickets detailed enough for a lower-level model to finish with little supervision, so each one names files, current classes, target values, tests and screenshots.

**How to apply:** follow the epic's order (#111, #112 and #113 first; #125 last). Use the tiers rather than raw `backdrop-blur`. Record the chosen type option in [[sinag-design-direction]]. The workflow is [[spike-ticket-workflow]].
