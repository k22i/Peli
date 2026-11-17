---
status: proposed
date: 2026-11-17
---

# Device pairing: copying SIMKL, AniList and the TMDB key to another device by QR code, end to end encrypted

> **Proposed.** The transport (D or E) and the construction for the phrase path are the user's to choose (#133). The sections marked *(pending)* change with that answer. Everything else is built.

A viewer who connected SIMKL and AniList on the Mac, and typed their TMDB key there, wants them on the iPhone or iPad without signing in to each service again on each profile (#133, epic #126). The data already syncs once both devices are connected: each device scrobbles its own plays, `tracking.Import` pulls the history, and Nuvio carries progress and watched marks. So the gap is setup friction, not data sync. The tokens and the TMDB key stay off every server ([ADR-0038](0038-debrid-keys-stay-with-addons.md), [ADR-0042](0042-simkl-and-anilist.md)): pairing copies them from one device's Keychain to the other's, directly.

## Options

| Option | Verdict |
|---|---|
| A. Connect separately on each device (today) | **Kept as the fallback**, made easier: on a phone the SIMKL dialog says "Approve this code on any device, like your Mac", with the code large and a Copy button |
| B. Store the tokens in Nuvio | **No.** Secrets in a database Peli doesn't own (or a self-hosted one), against ADR-0038. Nuvio has no table for it |
| C. iCloud Keychain (`kSecAttrSynchronizable`) | **Not now.** It needs the macOS and iOS apps signed by one team with a shared access group. The Mac build is ad-hoc signed, and SideStore re-signs iOS with a free team and re-prefixes access groups. Revisit with a paid Developer account: it would then need no UI at all |
| D. Pair over the local network, keyed by a QR code | **Proposed** *(pending)*. No server; works on the same Wi-Fi with no internet; end to end encrypted; both directions |
| E. As D, relayed through Nuvio realtime | **Fallback, not built now** *(pending)*. It works across client-isolated Wi-Fi (hotels, some mesh and guest networks) and with the phone on cellular. Nuvio sees only ciphertext, timing and size. But it makes the iOS build *use* `internal/nuvio/realtime.go` (the package is compiled in today, only `internal/party` calls it), it depends on the `nuvio_realtime=1` endpoint on api.nuvio.tv (none on self-host), and a pairing topic needs a channel that Nuvio's realtime policies let two sessions of one account join. The seal is the same as D, so E can be added later behind the same UI |

## Threat model

What is protected: a SIMKL access + refresh token (the refresh token slides for 180 days), an AniList token (a year, no revoke), and the TMDB key, for each shared profile.

| Threat | Defence |
|---|---|
| **An attacker on the same Wi-Fi**, passive (records the traffic) | The bundle is sealed with XChaCha20-Poly1305 under a key the attacker doesn't have. On the QR path the key also mixes in an ephemeral X25519 exchange, so someone who records the transfer and *later* sees the QR (a photo, a screenshot) still can't open it. Plain HTTP is fine: TLS would add nothing the seal doesn't give |
| Same Wi-Fi, **active** (connects to the sender, or intercepts) | The sender answers only a request that proves it holds the QR's key (an HMAC under a key derived from `K`, over the session id and the receiver's ephemeral public key). Anything else is a bad try; three bad tries end the session. An interceptor that relays a good request gets ciphertext it can't open, and can't swap the receiver's key because the proof covers it |
| **Shoulder-surfed QR** (someone else scans or photographs the sender's screen) | Within the 3 minutes, on the same network, someone holding the QR can fetch the bundle. That's inherent to "one scan, no typing". Limits: the QR is on screen only while the dialog is open; it works once, so the owner's own scan then fails with "This code was already used"; the sender shows which device received it ("Sent to Kevin's iPhone"), and if that wasn't them, Disconnect › Everywhere revokes the SIMKL grant. AniList can't be revoked from Peli: say so and link to AniList's settings |
| **Replay** of a recorded request or response | Single use: the sender closes after one good transfer. The session id is in the seal's additional data, and the receiver refuses a session id it has already applied (kept for the session's lifetime). The expiry is checked on both sides, so an old QR is refused even if a sender somehow still answered it |
| **Wrong account** (a device signed in to someone else's Nuvio) | The QR (and the phrase path's first message) carries `SHA-256("peli-pair v1 account" ‖ nuvio user id)`, truncated to 16 bytes, also bound into the seal. The receiver compares it with its own before it connects, and refuses with "Sign in to the same Nuvio account on both devices" |
| Kids profiles | Never sent, never received: the bundle builder leaves them out, and `Apply` refuses a kids target. Tracking already refuses them |
| A malicious app on the same device | Out of scope: the tokens are already in that device's Keychain |
| Cellular exposure | The sender binds its listener only to the addresses of up, non-loopback interfaces with a private (RFC 1918 / ULA / link-local) address, never `0.0.0.0`, so nothing listens on a cellular interface |

## Transport (D) *(pending)*

- **Sender** ("Add to another device"): picks the profiles (all non-kids profiles with a connection, by default) and the TMDB key (a checkbox). It listens on an ephemeral port on its LAN addresses, advertises `_peli-pair._tcp` over Bonjour as a hint, and shows the QR, the phrase and a 3-minute countdown. Cancel stops it at once. The server shuts down after one good transfer, three bad tries, or 3 minutes.
- **Bonjour goes through the system's `dns_sd`** (`DNSServiceRegister`/`Browse`/`Resolve`, one cgo file for macOS and iOS), not a Go mDNS library. A raw multicast socket on iOS needs the restricted `com.apple.developer.networking.multicast` entitlement, which a free SideStore team can't have; `dns_sd` needs only `NSBonjourServices` and `NSLocalNetworkUsageDescription`.
- **Receiver** ("Copy from another device"): scans the QR, or types the phrase. It connects, receives, opens the seal, shows a summary, and saves to the Keychain only after the user confirms.
- **QR payload:** `peli-pair:v1:<base64url>` of a fixed binary layout: version, expiry (Unix seconds), session id (16 bytes), account hash (16 bytes), `K` (32 bytes), the sender's ephemeral X25519 public key (32 bytes), port, then up to four IPv4/IPv6 addresses. About 140 bytes, a version 7 QR at error correction M.
- **iOS permissions:** `NSLocalNetworkUsageDescription`, `NSBonjourServices = [_peli-pair._tcp]`, `NSCameraUsageDescription`. The first LAN connection shows the Local Network prompt. A denial shows as an immediate "no route to host" to a private address; the receiver then says "Peli can't reach your other device. Allow Local Network for Peli in Settings" with a button to the app's Settings page.
- **macOS:** an ad-hoc signed app that listens on the LAN may raise the firewall's "accept incoming connections?" prompt the first time it sends. That's checked on the user's Mac, and the Settings copy mentions it.

## Construction

### QR path (`K` is 256 bits from the QR)

1. The receiver makes an ephemeral X25519 key pair `(r, R)` and sends `POST /pair/<session>` with `R` and `proof = HMAC-SHA256(HKDF(K, "peli-pair v1 proof"), session ‖ R)`.
2. The sender checks the proof (constant time), computes `ss = X25519(s, R)`, and answers `nonce ‖ XChaCha20-Poly1305(key, nonce, bundle, aad)`, where `key = HKDF-SHA256(ikm = K ‖ ss, salt = session, info = "peli-pair v1 seal")` and `aad = "peli-pair v1" ‖ session ‖ account hash ‖ S ‖ R`.
3. The receiver opens it with the same key. Any change to the ciphertext, the session, the account hash or either public key fails the tag.

All of it is `golang.org/x/crypto` (`chacha20poly1305`, `curve25519`, `hkdf`) and the standard library (`crypto/hmac`, `crypto/sha256`, `crypto/rand`).

### Phrase path (weaker: typed, for a receiver with no camera) *(pending)*

Six words from a 2,048-word list are 66 bits. The QR's addresses and a 128-bit session id don't fit in that, so the phrase is 16 bits that pick the session out of the Bonjour adverts (the TXT record carries them) and 50 bits of secret. The receiver finds the sender by Bonjour only. A secret that small can't be used as a key directly; the candidates:

| | Construction | Offline attack by a passive same-Wi-Fi recorder | Dependencies |
|---|---|---|---|
| **P1** | **CPace** (a balanced PAKE, picked by the IRTF CFRG in 2020) over ristretto255, through `filippo.io/cpace` | **None**: each guess needs a live run against the sender, and three bad tries end the session | `filippo.io/cpace` + `filippo.io/edwards25519` (already in `go.sum`). By Go's former crypto lead, small, readable, but only pseudo-versions and an early draft of the spec |
| P2 | **SPAKE2** (as magic-wormhole uses for its short codes) | None, as P1 | No maintained Go package of standing (`schollz/pake` and `gospake2` are niche). Writing it over `edwards25519` is rolling our own crypto. Not recommended |
| P3 | **Noise `NNpsk0`**, the PSK = `Argon2id(phrase, salt = session tag, 64 MiB, 3 passes)` | **Yes**: the first handshake message's tag lets someone who recorded it test guesses offline, slowed only by Argon2id. 50 bits at about 10⁴ guesses a second (a GPU rig) is about 3,600 years for the whole space, so it holds, but the margin rests on the Argon2id cost (which the phone has to pay too) and the attacker's budget, not on the protocol | `golang.org/x/crypto` only (`argon2`, `curve25519`, `chacha20poly1305`, `hkdf`), optionally `github.com/flynn/noise` |
| P4 | **Turn the QR round**: the device with a camera always scans. When the Mac is the receiver, the *Mac* shows the QR (its addresses, `K`, its public key) and the phone scans it and **pushes** the bundle. The phrase is then needed only between two Macs (or with the camera denied), with P1 or P3 for that case | None on the QR legs | As the QR path. It changes the flow the ticket describes ("iPad → Mac with the phrase" becomes "the Mac shows a code, the iPad scans it") |

After any of them, the bundle is sealed exactly as on the QR path, with the PAKE's (or Noise's) output as `K`.

### Bundle

JSON before sealing, never logged:

```json
{ "v": 1,
  "profiles": [{ "nuvioIndex": 1, "name": "Kevin",
                 "simkl": { "access": "…", "refresh": "…", "expiresAt": 0, "user": "…" },
                 "anilist": { "token": "…", "expiresAt": 0, "userId": 0, "user": "…" } }],
  "tmdbKey": "…",
  "sender": { "deviceName": "Kevin's Mac", "platform": "macos" },
  "createdAt": 0 }
```

No Nuvio session, no debrid keys, no addon URLs: those already sync through Nuvio, or aren't Peli's. `internal/pairing` builds it from `tracking.Export` (a package function, not a bound method, so the webview never sees a token) and applies it with `tracking.Adopt`, which writes the Keychain and the store's link exactly as a sign-in does, then `ImportSoon` for each profile.

## Matching profiles

- Both devices must be on the same Nuvio account (the account hash above).
- A profile matches by `NuvioIndex`. The receiver's summary lists each sent profile with the local profile it goes to.
- A sent profile with no local match (the receiver has fewer Nuvio profiles, or is on a local-only Guest) is listed as "Choose a profile for Kevin…" with the local non-kids profiles that aren't otherwise matched, or "Skip". Guest is never matched by itself.
- Kids profiles never send or receive.
- A local profile that already has a connection keeps it unless the user ticks "Replace" for that row. A replaced SIMKL grant is not revoked: it may be the other device's own.

## Shared SIMKL grants and disconnecting

- SIMKL's `Refresh` returns the **same** refresh token, so two devices can hold one grant. A refresh does invalidate the other device's access token; that device's next call gets a 401, refreshes once (`withSimkl` already retries) and carries on. Refreshes happen about weekly, so the cost is one extra call a week.
- A grant that was sent or received through pairing is marked shared: `store.SimklLink.Shared` (and `AniListLink.Shared`) lists the other devices' names. It lives in the profile's bucket rather than as a `simkl.shared.<profileID>` Keychain item, because it isn't secret and should go when the profile does.
- Disconnect on a shared SIMKL grant asks:
  - **On this device only**: forget the local tokens, no revoke (`Tracking.ForgetSimkl`);
  - **Everywhere**: revoke (`Tracking.DisconnectSimkl`, as before), which signs the other devices out on their next call. They then show "SIMKL was disconnected on another device. Connect again." (a refused refresh on a shared grant).
- AniList has no revoke: Disconnect only ever forgets it here, and on a shared grant the dialog says the other devices stay connected.
- An unshared grant disconnects as before (revoke, no question).

## Not in scope

Settings Nuvio doesn't carry (subtitle style, stream preferences, gestures). The same channel could carry them later as another bundle section, with its own checkbox; that's a separate decision.

## Consequences

- A new package, `internal/pairing`, in both builds; one `dns_sd` cgo file for darwin; a QR scanner in `internal/shell` (AVFoundation's `AVCaptureMetadataOutput`, because VisionKit's `DataScannerViewController` is Swift-only and the iOS build has no Swift; desktop twin returns "unavailable").
- `ios_boundary_test.go` is unaffected by D. E would add a call path into `nuvio/realtime.go` on iOS.
- The receiver writes to the Keychain only. Nothing is written to Nuvio, SIMKL or AniList by pairing itself; the import that follows only adds watched marks, as any connect does.
