---
name: macos-packaging
description: "#78/ADR-0053 macOS release: per-arch drag-to-Applications ULMO DMGs via build/darwin/dist.sh, hardened runtime (ad-hoc builds need entitlements.adhoc.plist), notarize app then DMG, native keychain for Developer ID builds; no Developer ID on this Mac yet"
metadata:
  type: project
---

#78 (2026-11-12): `wails3 task darwin:package:dmg [ARCH=amd64]` builds `bin/Peli.app` (bundle renamed from `peli.app`; executable still `peli`) and `bin/Peli-<version>-<arch>.dmg`. `wails3 task darwin:release ARCH=…` also signs with `PELI_SIGN_IDENTITY` and notarizes with `PELI_NOTARY_PROFILE` (or `PELI_NOTARY_KEY`/`_KEY_ID`/`_ISSUER`). Everything is in `build/darwin/dist.sh` (sign, check, dmg, notarize). The user asked for drag-to-Applications installs, not a click-through installer.

**Why:** ADR-0005 limits each DMG to 60 MB per architecture. At 0.1.0 they were 19.3 MB arm64 and 22.3 MB x86_64 as ULMO (UDZO was 27.2 MB).

**How to apply:**
- **This Mac has no Developer ID certificate** (`security find-identity -v -p codesigning` shows none), so nothing has been notarized yet. Until the user sets one up, the DMGs are ad-hoc signed.
- Ad hoc plus the hardened runtime fails library validation ("different Team IDs") and dyld won't load libmpv. That's why ad-hoc signing uses `entitlements.adhoc.plist` (`disable-library-validation`), and `check` refuses it on a Developer ID build. The release `entitlements.plist` is empty on purpose.
- The DMG background is `build/darwin/dmg-background.tiff` (1×+2×), rendered from `dmg-background.html` with headless Chrome plus `tiffutil -cathidpicheck`. The wordmark sits at the top because the user's Finder path and status bars cover the bottom. To see the window: `open` the DMG, then `screencapture -l<id>` with the Finder window id taken from CGWindowList.
- Keychain (ADR-0007 revisit): `internal/secrets/native_darwin.go` is used only when the running code has a Team ID. It migrates the `Peli` items once and leaves a `_native` marker. Probe result: Security.framework reads and updates the security tool's items without a prompt, but deleting one gives -25244, so native `set` deletes (falling back to the tool) and then adds.
- Related: [[libmpv-build]], [[platform-priority]], [[product-name-peli]].
