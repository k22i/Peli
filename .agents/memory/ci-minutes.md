---
name: ci-minutes
description: GitHub Actions on a private repo with GitHub Free and few minutes left — macOS Apple silicon only since 2026-11-26 (Windows, Linux and Intel commented out), verify locally before pushing, ios.yml disabled until ci.yml is green
metadata:
  type: feedback
---

k22i/Peli is private on GitHub Free and nearly out of Actions minutes (2026-11-22). A macOS minute costs 10, Windows 2.

- **Since 2026-11-26 the pipelines check macOS Apple silicon only** (the user: "don't do linux and windows builds… don't even test them", "ignore mac tests and builds that aren't mac M chips", "minimize CI/CD time"). Commented out, not deleted: `ci.yml`'s `go` and `build` matrices keep only `macos-26`, the whole `dev-smoke` job and its `workflow_dispatch` input are commented out, `release.yml`'s `macos` matrix and `libmpv` matrix keep only arm64, and the feed/`gh release create` carry `darwin/arm64` alone. Restoring an OS is uncommenting its matrix entry, its steps, and the "Fetch libmpv" block.
- Left alone on purpose: `frontend` and `licences` stay on `ubuntu-26.04` (JavaScript and Go tooling, not an OS build; the cheapest minute), `contract` stays on ubuntu for its daily self-host run, `ios.yml` is already `xcode-27` (arm64), `libmpv.yml` was already macos-arm64 only.
- Runners: the newest image of each OS only — `macos-26` (arm64), `windows-2025`, `ubuntu-26.04`. No Intel Mac, no older images ("don't worry about old shit").
- Before every push, run what CI runs locally (frontend fmt/lint/typecheck/test/build on Node 26, gofmt, `go vet`, `go test -race ./internal/...`, notices diff). Read failed job logs with `gh api repos/k22i/Peli/actions/jobs/<id>/logs`, and cancel a run already known to fail.
- ci.yml went green on 2026-11-22 (run 44989764158) and `ios.yml` was re-enabled after being disabled for the fix. If CI needs fixing again, the user may want `gh workflow disable ios` until it's green.
- CI facts: Ubuntu 24.04's libmpv 0.37 is too old for the player (26.04 has 0.41); Node 24.9 fails a subtitles test, so CI uses Node 26; the Wails CLI in ci.yml must match go.mod's Wails.

**Why:** the user said "please be intentional with your changes — i'm only on github free and i have very limited GHA minutes", then "make your next fixes count", and on 2026-11-26 asked to cut the Windows/Linux/Intel runs entirely to shorten a run.
**How to apply:** pushing to fix CI is fine when asked (an exception to [[local-only-git]]); batch fixes into as few runs as possible. Keep new pipeline work macOS arm64; a Windows or Linux job comes back only when the user asks. Related: [[platform-priority]].
