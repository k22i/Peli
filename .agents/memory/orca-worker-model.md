---
name: orca-worker-model
description: Orca subworkers for staysh/Peli run on Opus 5.5 at high effort, after Sonnet 5.5 medium struggled on the iOS port
metadata:
  type: feedback
---

Start Orca orchestration workers with `--agent claude --model claude-opus-5-5 --effort high`.

**Why:**
- On 2026-11-12 the user asked for Sonnet 5.5 at medium effort.
- On 2026-11-13 they switched to Opus 5.5 at high effort mid-Phase 5 of the iOS port: "i think sonnet 5.5 medium is struggling".
- The Sonnet workers twice ended a turn to "wait for" a background job, and stalled without reporting.

**How to apply:**
- Use Opus 5.5 at high effort for every `worker-start` unless the user names another model.
- When handing over from a stopped worker, put its finished commits, findings, rig and live-write undo state into the new spec.
- Tell workers to wait in the foreground, with bounded loops, rather than ending a turn.
