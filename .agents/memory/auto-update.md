---
name: auto-update
description: "#83/ADR-0054 internal/updates on Wails' pkg/updater: signed endpoint feed, release key in the user's keychain, darwin bundle checks, Taskfile VERSION order, e2e recipe"
metadata:
  type: project
---

#83 (2026-11-12): `internal/updates` drives Wails v3's own `pkg/updater` (beta.28 has one: endpoint/github providers, ed25519ph, a helper that re-execs `peli` with `WAILS_UPDATER_HELPER*` to swap the bundle and `open -n` it). Peli adds `signed` (refuses unsigned/oversized releases), `installed_darwin.go` (bundle location checks; after download: Info.plist version == feed version, same bundle id, codesign verify, same Team ID) and the `Status` service + `updates:status` event. `tools/updates` keygen/feed/verify. `dist.sh zip` / `darwin:package:zip` make the update zip. `main.go` calls `updater.HandleHelperMode()` right after `plugins.ServeChild()`.

**Why:** the user wanted signed updates that never restart during playback; Wails already does the hard part (swap, rollback, relaunch).

**How to apply:**
- The release key exists (2026-11-12): `updates.PublicKey` is set, and the private seed is in the user's login keychain as "Peli update signing" (`security find-generic-password -s "Peli update signing" -w`). The auto-mode classifier blocked me from writing that item, so the user ran keygen themselves. Never print the seed or commit a throwaway key.
- The repo is private, so the feed URL 404s (Wails reads it as up to date) until the repo or the feed goes public.
- Task reads vars in order: `VERSION` must come before `BUILD_FLAGS` in `build:native`, or `appinfo.Version` is stamped empty (which the updater treats as a dev build).
- E2E recipe that worked: package 0.1.0, copy `bin/Peli.app` to the scratchpad, bump Info.plist to 0.1.1, `darwin:package:zip`, restore the plist, sign a feed with a scratch key (temporarily as `PublicKey`), `python3 -m http.server` on 127.0.0.1, run the copy with `PELI_UPDATE_URL` + `PELI_DATA_DIR` and a temporary hook calling Check then Restart. The helper log is `$TMPDIR/wails-update-<pid>.log`. The relaunched app gets **none of your env** (LaunchServices), so it opens the real data folder: kill it by PID.
- Tests under `internal/updates` are written but weren't run in #83 (the user asked not to run tests yet). They run a signed zip through the real `updater.New`.
- Windows waits for #77's installer choice (per-user install, or run the installer silently); Linux is in #103. Related: [[macos-packaging]], [[platform-priority]].
