---
name: rex-workers
description: Launching Claude Code workers in Rex tabs for Peli: use the full ~/.local/bin/claude path, own worktree, spec file, report file, Monitor the pane
metadata:
  type: reference
---

Rex tabs start a login shell whose PATH finds an older `/usr/local/bin/claude`, which rejects `--permission-mode auto`. Launch workers with the full path:

`rex window new -s "$REX_SESSION" worker-<n> -c <worktree> --focus=false --keep-open --json -- /Users/kevinmallari/.local/bin/claude --model claude-opus-5-5 --effort medium --permission-mode auto "Read <spec> and carry it out completely."`

**How to apply:**
- Create one worktree per ticket under `~/rex-work/staysh/<slug>`, on branch `k22i/<slug>`.
- Write the spec outside the repo, and have it write its final report to `~/rex-work/staysh/<slug>.report.md`.
- Watch with a Monitor loop on the report file, new commits and `rex capture`. Don't match on "Allow": auto mode prints "Allowed by auto mode".
- The worktree has no `spikes/stream-ranking/.env`: point workers to the main checkout's copy.
- The user asked for Opus 5.5 at medium effort for Rex workers on 2026-11-17 (epic #49), whereas Orca workers use high effort ([[orca-worker-model]]).
- Related: [[local-only-git]].
