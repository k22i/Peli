---
name: ios-sidestore
description: Peli on real iPhone/iPad via SideStore (free Apple ID): ad-hoc .ipa tasks, what SideStore rewrites (bundle id + team id, entitlements), App ID/cert limits, iloader + LocalDevVPN, devicectl console logs, stats log line
metadata:
  type: project
---

Since 2026-11-17 the user installs Peli on their own iPhone and iPad with SideStore, signed with a free Apple ID (no paid identity on this Mac). Procedure, checklist and limits: `ios/README.md` "On a real device"; wizard `build/ios/scripts/sidestore-setup.sh`; results go in `docs/ios/device-run.md`.

**Why:** a free account and no 7-day re-signing from the Mac; SideStore refreshes on the device.

**How to apply:**
- Build: `wails3 task ios:sideload` (production device .ipa → `bin/ios/peli.ipa` + iCloud Drive/Peli). `ios:package:ipa IOS_PLATFORM=device IOS_PRODUCTION=false` is the debug one. The app name is lowercase (`peli.ipa`, `Payload/peli.app`): zip entries are case-sensitive even though the disk isn't. Ad-hoc is enough, because SideStore re-signs. `CFBundleVersion` is stamped `YYYYMMDD.HHMM` per build.
- To only prove a device build compiles (workers, branches), use `wails3 task ios:package:ipa IOS_PLATFORM=device`, never `ios:sideload`. **Why:** sideload copies its .ipa to iCloud Drive/Peli/peli.ipa, which overwrites the build the user installs from (the coordinator's correction, 2026-11-17). **How to apply:** run `ios:sideload` only when the user asks for an install build from main.
- Taskfile trap: the global vars (`IOS_SDK`, `IOS_TARGET`, `LIBMPV_SLICE`) are computed from `IOS_PLATFORM` once, at load. Passing `IOS_PLATFORM` to a task *call* doesn't change them, so `sideload` shells out to `wails3 task ios:package:ipa IOS_PLATFORM=device`.
- What SideStore does (read in its source, `SideStore/SideStore` develop and `SideStore/SideSign`, 2026-11): bundle id becomes `<id>.<TEAMID>` (`appendTeamID` defaults to true), and it rewrites `CFBundleIdentifier`. Entitlements are the profile's, filtered to the keys the app has, plus `application-identifier`, team id and `get-task-allow`. App `keychain-access-groups` get re-prefixed with the team id. Frameworks are re-signed with no App ID; each appex costs an App ID. Background refresh is iOS background fetch (plus a silent-audio keep-alive). The Shortcuts actions are "Refresh All Apps" and "Install IPA". There's one certificate per device ("SideStore - X's <device>"); the second device may offer to revoke the first's, which must be refused.
- Peli has no bundle-id dependencies: no URL scheme, the AniList loopback redirect, and the Keychain with no access group (default group = application-identifier, stable across refreshes on the same Apple ID; a different Apple ID gives an empty Keychain).
- SideStore docs (docs.sidestore.io; sidestore.io/docs is a 404): the installer is **iloader** (it also places the pairing file; re-place after iOS updates or resets, or on AFC/1006 errors). The VPN is **LocalDevVPN** (StosVPN/WireGuard are out); it plus Wi-Fi is needed for every install or refresh. Developer Mode is on iOS 16+. The docs don't cover background refresh, Shortcuts or bundle ids: those facts come from the source.
- Logs: `wails3 task ios:device:console DEVICE_ID=… [ENV='{"PELI_HWDEC":"no"}']` finds `k22i.net.peli.*` via `devicectl device info apps` and launches with `--console`. Peli's `slog` goes to stderr in both builds; production only drops Wails' internal tracing. Debug has `-gcflags=all=-l` (no inlining), so measure CPU on production. `iosplayer: stats` (internal/iosplayer/stats.go) logs fps, drops and process CPU every 15 s while playing. The Web Inspector is on in all builds (no `DisableInspectable`).
- Tests that write: use the Guest profile with the user's debrid addon added. Resolving still adds to TorBox (list what was played and delete it). See [[live-tests-push-to-nuvio]] and [[nuvio-live-account]].

Related: [[ios-port]], [[ios-libmpv]], [[debrid-keys]].
