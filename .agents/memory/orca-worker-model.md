---
name: orca-worker-model
description: Orca subworkers for staysh/Peli run on Opus 5.5 by default; Sonnet 5.5 is fine for smaller, less crucial tickets; effort as the user names it
metadata:
  type: feedback
---

Start Orca orchestration workers with `--agent claude --model claude-opus-5-5`, and use the effort the user names (`--effort high` by default; for epic #126 the user asked for `medium`).

For smaller, less crucial tickets (small-fix lists, P2 conveniences, contained UI layout work), `--model claude-sonnet-5-5` is fine. Keep Opus for P0 work, native bridges, crypto/security, spikes and anything other tickets build on.

**Why:**
- On 2026-11-12 the user asked for Sonnet 5.5 at medium effort.
- On 2026-11-13 they switched to Opus 5.5 at high effort mid-Phase 5 of the iOS port: "i think sonnet 5.5 medium is struggling". The Sonnet workers twice ended a turn to "wait for" a background job, and stalled without reporting.
- On 2026-11-17 (epic #126) the user said: "for smaller and less crucial subtickets, Sonnet 5.5 can be used instead of Opus".

**How to apply:**
- Pick the model per ticket by size and how crucial it is.
- When handing over from a stopped worker, put its finished commits, findings, rig and live-write undo state into the new spec.
- Tell workers, Sonnet especially, to wait in the foreground with bounded loops rather than ending a turn.
- **mistral-vibe workers** (2026-11-21, user's pick for the lighter two thirds of the watch-party reactions/dock work): `--agent mistral-vibe` with no `--model` uses `~/.vibe/config.toml`'s active model (DeepSeek V4.1 Flash, thinking high). Vibe refuses to start in an untrusted folder (`agent-trust-workspace`). The user added `~/orca/workspaces/staysh` to `~/.vibe/trusted_folders.toml`. Editing that file is the user's call, so ask rather than doing it. Vibe shells don't load nvm, so they get Homebrew's Node 24.9 ([[local-node-version]]).
- `--worktree new-child` worktrees were cut from an old ancestor of main (7cc1744) that day. Put "compare HEAD with main and move to main before editing" in every spec, and for fix rounds after a merge, `git checkout -B <branch> main`.
- Run `pnpm check` (lint and format) as well as typecheck and tests after merging. Code-only workers left 7 lint errors that the other checks didn't catch.
- **Fix rounds to vibe workers start fresh** (2026-11-22): `send` to a finished mistral-vibe worker comes back `delivery=started_fresh`, a new terminal with no memory of its first task, so a fix message must stand alone (branch, files, exact errors). Claude workers get a follow-up in the same session. Parallel workers that each add the same import (here `isPartyGuest` in player-page.tsx) merge into a duplicate identifier, which breaks the whole test file: check imports after each merge.
