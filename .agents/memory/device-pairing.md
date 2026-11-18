---
name: device-pairing
description: "#133/ADR-0061 copying SIMKL/AniList/TMDB between devices: camera always scans (P4), LAN only (D), CPace phrase Mac↔Mac, internal/pairing layout, shared grants + ForgetSimkl, scanner in shell, gotchas"
metadata:
  type: project
---

Device pairing (#133, ADR-0061, decided by the user 2026-11-17: **D** LAN only, **P4** camera always scans, **P1** CPace phrase for Mac↔Mac only; Nuvio realtime relay (E) is the follow-up only if client isolation bites).

**Why:** the user wants SIMKL/AniList on the iPhone/iPad without signing in again, with no secret passing through any server (ADR-0038).

**How to apply:**
- Roles are shower (shows the QR, listens) and scanner (connects). The mode in the code says which way grants go: offer (shower sends) or request (shower receives, phone pushes). A Mac never scans; a phone never shows a phrase.
- `internal/pairing`: `bundle.go` (Offer/Build/Match/Apply/MarkSent, tokens never in bindings), `code.go` (peli-pair:v1 binary QR), `seal.go` (HMAC(K) proof, HKDF(K‖X25519), XChaCha20-Poly1305, AAD = direction/mode/session/account/S/R), `server.go` (single use with a `claimed` flag, 3 bad tries, 3 min, private LAN addresses only, skips pdp_ip/utun/awdl), `client.go`, `bonjour_darwin.{go,c,h}` (dns_sd, macOS only; iOS has no Bonjour code and no NSBonjourServices key), `words.go` (EFF short list 1, CC BY 3.0: credit kept in the source), `service.go` (bound API + MarshalError codes, mirrored in `lib/pairing.ts`).
- `tracking/share.go`: `Export`/`Adopt`/`MarkShared` are package funcs (not bound). `SimklLink.Shared`/`AniListLink.Shared` (omitempty, so typed test fixtures still compile). `ForgetSimkl` = disconnect without revoke. Settings: shared grant → `SharedDisconnectDialog`; needsReconnect + shared → "disconnected on another device".
- Scanner: `shell.ScanQR(prefix)` is AVFoundation (VisionKit's DataScannerViewController is Swift-only, no ObjC headers). `shell.OpenAppSettings` for camera/Local Network denied. Shell's bound-method list (shell_test.go) and file list (ios_boundary_test.go) were updated for it.
- iOS gives apps no device name: the frontend passes `deviceName()` ("iPhone"/"iPad") as `label`; a Mac uses `scutil --get ComputerName`.
- Live runs copy the user's real tokens between Keychains: the user runs them. Never log a bundle.
- Related: [[tracking-integrations]], [[ios-port]], [[tmdb-key]], [[debrid-keys]].
