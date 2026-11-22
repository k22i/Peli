---
name: ci-minutes
description: GitHub Actions on a private repo with GitHub Free and few minutes left — newest runners only, verify locally before pushing, ios.yml disabled until ci.yml is green
metadata:
  type: feedback
---

k22i/Peli is private on GitHub Free and nearly out of Actions minutes (2026-11-22). A macOS minute costs 10, Windows 2.

- Runners: the newest image of each OS only — `macos-26` (arm64), `windows-2025`, `ubuntu-26.04`. No Intel Mac, no older images ("don't worry about old shit"). libmpv.yml builds macos-arm64 only, cached by `hashFiles('build/libmpv/**')`.
- Before every push, run what CI runs locally (frontend fmt/lint/typecheck/test/build on Node 26, gofmt, `go vet`, `go test -race ./internal/...`, notices diff). Read failed job logs with `gh api repos/k22i/Peli/actions/jobs/<id>/logs`, and cancel a run already known to fail.
- `ios.yml` was disabled with `gh workflow disable ios` on 2026-11-22; re-enable it (`gh workflow enable ios`) once ci.yml is green.
- CI facts: Ubuntu 24.04's libmpv 0.37 is too old for the player (26.04 has 0.41); Node 24.9 fails a subtitles test, so CI uses Node 26; the Wails CLI in ci.yml must match go.mod's Wails.

**Why:** the user said "please be intentional with your changes — i'm only on github free and i have very limited GHA minutes", then "make your next fixes count".
**How to apply:** pushing to fix CI is fine when asked (an exception to [[local-only-git]]); batch fixes into as few runs as possible. Related: [[platform-priority]].
