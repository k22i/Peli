---
name: spike-ticket-workflow
description: "How the user wants Staysh M0 spike tickets executed and reported on GitHub (main branch, issue comments, project board)"
metadata:
  node_type: memory
  type: feedback
  originSessionId: cb7c65c2-a206-4428-97e0-be9a78729230
  modified: 2026-10-19T16:58:36.459Z
---

For Staysh spike tickets (epic #1), the user asks for all work directly on `main` (no branch, no PR) and for the GitHub issues to be kept up to date.

**Why:** the epic's convention (progress comments, `docs/spikes/<topic>.md`, closing verdict) is followed, but the user explicitly waives the PR step; #2 and #3 were both committed straight to main.

**How to apply:**
- Spike code under `spikes/<topic>/` (own Go module), findings in `docs/spikes/<topic>.md`, raw results committed under `spikes/<topic>/results/`, screenshots as JPG in `docs/spikes/<topic>/`.
- Post a progress comment on the ticket mid-way; the final commit uses `Closes #N`; then post a verdict comment (table + links to commits/CI runs, noting "no PR, committed to main").
- Tick the ticket's task checkboxes, move it on the "Staysh Roadmap" project (owner k22i, project 4) to In Progress when starting and Done at the end (`gh project item-edit`).
- Since the M0 gate (#8, 2026-10-12): P0 work is split into milestones M1/M2/M3 (the "v1.0 — MVP" milestone is closed), the board has an "Estimate (days)" number field, and decisions live in `docs/adr/` (index in its README). Tickets carry a "From the M0 gate (#8)" section with spike findings.
- Since 2026-10-19 the project is **Sinag** (repo `k22i/Sinag`, Go module `github.com/k22i/Sinag`); the same workflow applies to M1 tickets (e.g. #10 under epic #9: progress comment, commit `Refs #N`, verify, then verdict + close + board Done + epic comment). Board item IDs come from `gh project item-list 4 --owner k22i`.
- When a ticket's decision changes the plan (e.g. #14 picked bbolt over the planned SQLite, 2026-10-19), also edit the ticket's title and text and every downstream issue that names the old choice, add an ADR, and leave a hand-off comment on the ticket that builds on it. The board is now titled "Sinag Roadmap" (same project 4).
- `wails3 update build-assets` recreates `build/ios` — delete it again after running it.
- Add a short summary comment on the epic (#1) about the effect on its gate; don't tick gate boxes unless actually met.
- Windows testing has no local machine: use a manual `workflow_dispatch` workflow on `windows-2025` runners (2 vCPU, no GPU); Linux runs headless in Docker locally.
- macOS testing runs locally on the user's Mac (M1 Pro, external 3840x1600 non-HDR display) while they use it: windows may launch occluded, and `screencapture` can catch their other apps and notifications, so check every screenshot and crop or blank it before committing. A reusable harness for this is in `spikes/mpv-render-api/scripts/macos/`.
- Hand-off comments also go on tickets that later revisit a decision (e.g. #15 left notes on #22 and #78, 2026-10-19). Docker Desktop may not be running: start it with `open -a Docker` and wait for `docker info`.
- Since #16 (2026-10-19) all app CI is one `.github/workflows/ci.yml` (frontend, go ×4 OS, build ×4 OS, manual dev-smoke); add new checks there, not new workflows. It has `paths-ignore`, so an empty commit won't trigger it on a PR. The repo is private on the Free plan, so it can't have branch protection, and macOS minutes are billed at 10×. pnpm/action-setup fails on macos-15-intel: install with `npm i -g` at the `packageManager` version instead.
- Driving the built macOS app works (#17, 2026-10-19): run `bin/sinag` with `SINAG_DATA_DIR` in the scratchpad, send keys with `osascript` System Events (`keystroke "," using command down`; ⌘, opens Settings), `screencapture -R` only the window rect. WKWebView Tab skips buttons and links (the user's keyboard-navigation setting is off), so use Option+Tab.
- Before sending osascript keystrokes, check the frontmost process: if it's `loginwindow`, the screen is locked and keys go to the lock screen (happened in #20, 2026-10-19). Then screenshot the frontend in headless Chrome with a throwaway Vite config that aliases `@bindings/*` to stub modules (`vp dev --config`, CDP script), and only window-capture the native app (`screencapture -l`, no input).
- Stubbed-frontend screenshots (#23, 2026-10-20): the throwaway Vite config must sit inside `frontend/` (it imports `vite-plus` and `./vite.config.ts`; delete it afterwards). Use `mergeConfig` with `resolve.alias` regex `^@bindings/(account|store|...)$` → scratchpad stubs, and `pnpm exec vp dev --config` (vp isn't on PATH).
- More on stubbed screenshots (#24, 2026-10-20): the router uses in-memory history, so the URL path is ignored. Reach a screen by loading `/` and clicking through (CDP `Input.dispatchMouseEvent`), and pick stub data with `?scene=` saved to sessionStorage. In Vitest, Base UI submenu items fail userEvent clicks with `pointer-events: none`, so drive submenus with the keyboard (Enter opens the menu with the first item focused, then ArrowRight).
- The user sometimes says not to push (e.g. Actions down, #24): still commit, close the ticket and set the board to Done, but say in the verdict that the commits aren't pushed and CI hasn't run.
- The user's real macOS keychain holds a live Sinag session (service "Sinag", from #20/#22), so the built app always launches signed in. Don't use it for "no session" checks, and never delete it: test those in Go with `memKeychain`.
- Docker: base Linux spike images on `golang:1.25-trixie` (downloading Go from go.dev inside Docker kept failing). On headless sway, `wlrctl`/`wtype` can't drive GTK; use `spikes/mpv-render-api/scripts/linux/vinput/`.
