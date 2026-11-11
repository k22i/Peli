---
name: frontend-stack-preferences
description: "User's required frontend tooling for Peli (pnpm, Vite+, TanStack, coss ui, React 19, TS 7) and local gotchas"
metadata:
  node_type: memory
  type: feedback
  originSessionId: 6f5e502a-6106-4731-a165-6fe443608c75
  modified: 2026-10-19T04:59:07.034Z
---

For Peli's frontend the user wants: **pnpm** (never npm), the whole **Vite+** ecosystem (`vite-plus`: Vite, Vitest, Oxlint, Oxfmt — no ESLint/Prettier), **TanStack** Router/Query, **coss ui** (https://coss.com/ui, shadcn registry on Base UI) for components, React 19 and TypeScript 7. Set up in #11 (2026-10-19).

**Why:** the user asked for these explicitly, overriding the ticket text (ESLint + Prettier, npm); they favour performance and newest stable versions.

**How to apply:**
- Add coss components one at a time (`pnpm dlx shadcn@4.21.4 add @coss/<name>`), not the whole `@coss/ui` set (55 files / 10k lines). The registry item can omit deps (Button needed cva + lucide-react added by hand); pin exact versions afterwards.
- `minimumReleaseAge: 10080` in `frontend/pnpm-workspace.yaml` blocks packages under 7 days old; `vp migrate` adds a `minimumReleaseAgeExclude` list for the toolchain, so remove it.
- `wails3` is in `~/go/bin`, not on the default PATH. In zsh never use `path` as a loop variable (it is tied to PATH).
- For macOS screenshots, capture only the app window: `screencapture -l <id>`, picking the window whose name is "Peli" (the app also has 500x500 and menu-bar-sized windows).
- For the user to try the app by hand on macOS, run `wails3 task darwin:package` and `open bin/peli.app`: the bare `bin/peli` binary has no Dock icon and opens behind the terminal, so they couldn't find it. Ask them to do click tests themselves rather than posting synthetic CGEvents while they use the Mac.
- `shadcn add` prompts to overwrite existing files and hangs without a TTY: pipe `yes n |`. New coss files can fail the strict lint/types (exactOptionalPropertyTypes, no-unsafe-type-assertion); fix them minimally.
- Vitest stubs CSS imports (even `?raw`): read `src/index.css` from disk (`src/test/index-css.ts`). Worktrees need the git-ignored `frontend/bindings` copied in, or `vp check` fails.
- Screenshots of web UI: the Chrome extension's window is 3840 px wide and won't resize. A long headless `--screenshot` drops tiles. What works: headless Chrome with `--remote-debugging-port` plus a small Node CDP script (1280×800 at 2×, emulated prefers-color-scheme, scroll `#content`).
- For the user's taste: they suggested coss `scroll-area` for the content pane; they prefer coss components over hand-rolled ones where one fits.
- Related: [[spike-ticket-workflow]].
