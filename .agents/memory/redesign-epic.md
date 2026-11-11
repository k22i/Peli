---
name: redesign-epic
description: "Redesign epic #110 (2026-11-05): Apple TV × Music layout with Peli's own identity, more liquid glass, 1.5× cards, type rework keeping both fonts; sub-tickets #111–#125"
metadata:
  type: project
---

On 2026-11-05 the user asked for a total redesign: more liquid glass, posters and thumbnails bigger (2× asked, changed to 1.5× the same day), better layout everywhere (rows, settings groupings, player), Browse catalog chips that scroll sideways instead of wrapping, and a slightly bigger Home hero. Epic #110 (M3, P0, `area:design`), with sub-tickets #111–#125 on the Peli Roadmap board.

- **Inspiration:** Apple TV and Apple Music (floating glass sidebar, full-bleed art, shelves, a floating player bar), **but Peli keeps its own identity**: the lagoon `--brand` as the only accent, Nuvio near-black dark mode, its radius scale, and its section names.
- **Fonts:** the user dislikes the current type, yet said "keep Mona Sans" and "Geist Mono is also ok". So #112 changes usage only (widths, weights, sizes, where mono appears) and waits for them to pick specimen A, B or C.
- **Glass:** four tiers (`glass-thin`, `glass`, `glass-thick`, `glass-media`) defined in #111 and ADR-0046. CSS only (no SVG refraction, no motion library, no native vibrancy). Over video it's mostly tint, because mpv draws on a native layer under the webview.

**Why:** the user wants tickets detailed enough for a lower-level model to finish with little supervision, so each one names files, current classes, target values, tests and screenshots.

**How to apply:** follow the epic's order (#111, #112 and #113 first; #125 last). Use the tiers rather than raw `backdrop-blur`. Record the chosen type option in [[peli-design-direction]]. The workflow is [[spike-ticket-workflow]].

**#112 status (2026-11-05):** step 1 done (9642fa5): `gallery/type-specimens.tsx` (`typeOptions`, `TypeSample`) and `docs/design/type-specimen-{A,B,C}-dark.jpg`. On 2026-11-05 the user picked **B · Semi-wide** (comment on #112). Step 2 (rollout) ran after the page tickets merged, so it could sweep their final code.

**How the rest was built (2026-11-05):** the coordinator (Opus) ran #117–#124 as Orca workers (Sonnet 5.5, high), each in its own worktree branched from `main` (`~/orca/workspaces/staysh/redesign-<N>`, branch `k22i/redesign-<N>`). It reviewed each branch's diff and screenshots, rebased it onto `main` and fast-forwarded (no PRs, no push), then posted a "Built, not closed yet" comment with the real hashes. Workers drafted those comments in `~/Developer/staysh-notes/<N>-closing.md`. Gotchas: the append-only files (`MEMORY.md`, `docs/design/README.md`, `contrastPairs` in `contrast.ts`) conflict on every merge. A union resolver can split a `contrastPairs` entry mid-object, so run `pnpm check` after each merge. Give each worker its own Vite/CDP ports, and tell them never to `pkill -f` a shared pattern (two workers killed each other's servers).

**#117–#123 status (2026-11-05):** built and on `main`, left open until `pnpm test` is run (the user asked to skip tests) and pushed (Actions down). Open items, for #125: #121 needs the built-app blur check over video, but the session had no Screen Recording permission (`screencapture -l` fails); the #123 PIN dialog shots predate #122's dialog backdrop; Search has a tall gap under the field; the title page in light mode has a tall gap between the hero fade and Episodes; and the unchecked Switch in dark Settings is faint. The #125 QA pass fixed all of these except the blur check.

**#113 status (2026-11-05):** built (see [[card-sizes]]), left open until `pnpm test` is run; commits 879f629, 13ef549, 59dec47 not pushed (Actions down).

**#114 status (2026-11-05):** built (see [[app-shell]]), left open until `pnpm test` is run and the native sidebar is eyeballed; not pushed (Actions down).

**#116 status (2026-11-05):** built (see [[chip-rail]]), left open until `pnpm test` is run; commits 5b7e3a5, ab39ca0 not pushed (Actions down).

**#112 step 2, #124, #125 status (2026-11-05):** built and on `main` (#112 option B tokens and `.text-*` utilities; #124 motion with `lib/nav-direction.ts`; #125 checks 1–6 with fixes, README rewrite, gallery samples, ADR consequences). All of #112–#125 stay open until `pnpm test` runs and the commits are pushed (Actions down). #125 still needs from the user: VoiceOver, built-app perf/memory and the blur-over-video check (grant Screen Recording), the Windows dev-smoke run after a push, and the card-size sign-off. Then close the tickets, tick the epic's Done-when boxes and close #110.
