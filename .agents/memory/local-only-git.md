---
name: local-only-git
description: Work stays local on main for now; merge worker branches into main locally, never push or open PRs
metadata:
  type: feedback
---

Merge finished work (including Orca worker branches) into local `main`. Don't `git push` and don't create PRs.

**Why:** the user said on 2026-11-12, during the iOS port, "don't push and don't create PRs. i'm working locally only for now."
**How to apply:** commit and merge locally; leave GitHub alone (no pushes, PRs, or issue and ticket updates that assume pushed hashes) until the user says otherwise.
- Exception (2026-11-17, epic #49): the user approved closing built tickets on GitHub with a "built on local main, not pushed, CI hasn't run" comment, ticked tasks and the board set to Done. Ask again for other epics, unless the request covers it. Related: [[spike-ticket-workflow]], [[orca-worker-model]].
