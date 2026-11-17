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
