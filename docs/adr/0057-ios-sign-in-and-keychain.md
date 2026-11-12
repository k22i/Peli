---
status: accepted
date: 2026-11-13
---

# Signing in on iOS: email, or Nuvio's page in Safari; the session in Peli's own Keychain class

Phase 3 of the iOS port (ADR-0055) makes the account flows work on a phone. Two decisions needed a record: how someone signs in when the QR code has nothing to be scanned by, and which Keychain class the session lives in.

## What was decided

- **Email and password stays the first path**, as on the desktop (`Account.SignIn`; the page never sees a token). The fields are phone fields: 16 px text (WebKit zooms in below that), `inputmode="email"`, no autocorrect or capitalisation, "next" and "go" return keys.
- **QR sign-in becomes "Sign in on the web".** The QR route is the same device login (#21, ADR-0013): Go starts it, polls and keeps the session. On iOS the page does not draw the QR code (the one device that could scan it is the one showing it) and instead has an "Open the sign-in page" button, `Browser.OpenURL(code.url)`. Wails' iOS `OpenURL` is `UIApplication openURL:`, so it opens **Safari** (not an in-app `SFSafariViewController`): the user signs in to Nuvio there, approves Peli, and returns to the app, whose Go poll picks the session up. The short code and `nuvio.tv/link` stay on the page for approving from another device. A custom server has neither, as before.
- **The session is kept with `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`.** Wails' `Mobile.SecureSet` hard-codes `WhenUnlockedThisDeviceOnly` and offers no choice (`mobile_features_ios.m`, `ios_secure_set`). A push in the background (Phase 6: `DidEnterBackground` flush, background refresh, a push after a lock) has to read the session while the device is locked, which `WhenUnlocked` forbids. `AfterFirstUnlock` is readable from the first unlock after a boot, still never leaves the device and is not in a backup. `internal/secrets/keychain_ios.go` is therefore Peli's own small C layer over `SecItem*` (service `k22i.net.peli.secrets`, account `service/key` as before), behind the same `keyValues` adapter. It is the one cgo file `internal/secrets` may have on iOS (the boundary test names it). Items Wails wrote earlier under `wails.mobile.securestore` are not migrated: Phase 2 never signed in on a shipped build.

## Consequences

- A signed-in user opens a relaunched app signed in; sign-out deletes the items (`Keychain.Delete`).
- The Safari round trip leaves the app. Go's poll survives a short suspend; if it dies, the screen's "New code" restarts it.
- Screens that said "this computer" say "this device" on iOS (`thisDevice()`).
