---
name: tests-later
description: During the iOS port the user asked to skip test-suite runs and fix the failing tests in one pass afterwards
metadata:
  type: feedback
---

From 2026-11-13, for the rest of the iOS port, don't run `pnpm test` or `go test ./...` after every step. Keep builds, type checks (`pnpm check`, `go vet`) and simulator runs. The redesign epic did the same thing (see [[redesign-epic]]).

**Why:** the user said "in the interest of time, stop running tests for now. let's just fix them after."
**How to apply:**
- Worker specs say to skip test suites; a new test may still be written.
- The fix-up pass starts from the last full run on 2026-11-13, made with the machine at a load average of about 500–850. It had 176 failures in 25 files, against Phase 1's baseline of 62 in 16.
- New failing files since that baseline: `ios.test.tsx`, `app-shell`, `session`, `sign-in`, `qr-sign-in`, `discover`, `library-selection`, `title-menu` and `ranking/accuracy`.
- Go has 9 known failing packages (see [[ios-port]]).
