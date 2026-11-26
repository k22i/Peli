---
name: platform-priority
description: macOS first, then Windows; Linux deferred until after v1.0 (#103) — don't block tickets on Linux or Windows runs
metadata:
  type: project
---

Since 2026-10-31: build and test macOS first, Windows second. Linux is deferred until after v1.0. Its tasks are collected in #103, and #79 (Linux packaging) and #91 (Linux GPU measurement) are in the Later milestone at P2.

**Why:** the user wants to save time. Mac is the dev machine, and Windows and Linux runs are slow to get.

**How to apply:** since 2026-11-26 the pipelines themselves only run on macOS Apple silicon (Windows, Linux and Intel commented out — see [[ci-minutes]]), so a ticket is done once macOS passes and Windows is verified by hand if at all. Don't spend time on Linux runs (Docker, GTK hosts, AppImage). Keep existing Linux code compiling where it's cheap, but add new Linux-only work to #103 instead of doing it. Related: [[player-service]], [[hardware-decoding-hdr]], [[player-keys-media]].
