---
name: orca-worker-model
description: Orca subworkers for staysh/Peli run on Sonnet 5.5 at medium effort
metadata:
  node_type: memory
  type: feedback
  originSessionId: 4442a4ff-5827-4a66-819b-82135d9168d7
  modified: 2026-11-12T14:11:00.447Z
---

Start Orca orchestration workers with `--agent claude --model claude-sonnet-5-5 --effort medium`.

**Why:** the user asked for this mid-task on the iOS port (2026-11-12); the earlier redesign used Sonnet at high effort.
**How to apply:** use it for every `worker-start` unless the user names another model.
