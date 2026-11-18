---
status: accepted
date: 2026-11-17
---

# Device pairing: copying SIMKL, AniList and the TMDB key to another device by QR code, end to end encrypted

> **Decided by the user on 2026-11-17** (#133): **D** (the local network; E is the follow-up if client isolation bites), **P4** (the camera always scans) and **P1** (CPace) for the phrase between two Macs. The QR construction below was approved as proposed. AVFoundation's QR reader stands in for VisionKit's.

A viewer who connected SIMKL and AniList on the Mac, and typed their TMDB key there, wants them on the iPhone or iPad without signing in to each service again on each profile (#133, epic #126). The data already syncs once both devices are connected: each device scrobbles its own plays, `tracking.Import` pulls the history, and Nuvio carries progress and watched marks. So the gap is setup friction, not data sync. The tokens and the TMDB key stay off every server ([ADR-0038](0038-debrid-keys-stay-with-addons.md), [ADR-0042](0042-simkl-and-anilist.md)): pairing copies them from one device's Keychain to the other's, directly.

## Options

| Option | Verdict |
|---|---|
| A. Connect separately on each device (today) | **Kept as the fallback**, made easier: on a phone the SIMKL dialog says "Approve this code on any device, like your Mac", with the code large and a Copy button |
| B. Store the tokens in Nuvio | **No.** Secrets in a database Peli doesn't own (or a self-hosted one), against ADR-0038. Nuvio has no table for it |
| C. iCloud Keychain (`kSecAttrSynchronizable`) | **Not now.** It needs the macOS and iOS apps signed by one team with a shared access group. The Mac build is ad-hoc signed, and SideStore re-signs iOS with a free team and re-prefixes access groups. Revisit with a paid Developer account: it would then need no UI at all |
| D. Pair over the local network, keyed by a QR code | **Chosen.** No server; works on the same Wi-Fi with no internet; end to end encrypted; both directions |
| E. As D, relayed through Nuvio realtime | **The follow-up if client isolation bites; not built.** It works across client-isolated Wi-Fi (hotels, some mesh and guest networks) and with the phone on cellular. Nuvio sees only ciphertext, timing and size. But it makes the iOS build *use* `internal/nuvio/realtime.go` (the package is compiled in today, only `internal/party` calls it), it depends on the `nuvio_realtime=1` endpoint on api.nuvio.tv (none on self-host), and a pairing topic needs a channel that Nuvio's realtime policies let two sessions of one account join. The seal is transport-neutral (the request and answer are opaque sealed bytes), so E can carry the same two messages later behind the same UI |

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

## Transport (D)

**The camera always scans (P4).** The device that *shows* a code listens; the device that *scans* connects. The code's mode says which way the grants go:

| Direction | Shows the code (listens) | Scans (connects) | Mode |
|---|---|---|---|
| Mac → iPhone/iPad | Mac: Add to another device | iPhone: Copy from another device | offer |
| iPhone/iPad → Mac | Mac: Copy from another device | iPhone: Add to another device › Scan a Mac's code | request (the phone pushes) |
| iPhone → iPad | iPhone: Add to another device | iPad: Copy from another device | offer |
| Mac → Mac | Mac: Add to another device (QR + phrase) | Mac: Copy from another device, types the phrase | offer, CPace |

- The device showing a code picks the profiles first if it's sending (all non-kids profiles with a connection, by default) and the TMDB key (a switch). It listens on an ephemeral port on its LAN addresses and shows the QR (and on a Mac sending, the phrase) with a 3-minute countdown. Cancel stops it at once. It shuts down after one good transfer, three bad tries, or 3 minutes.
- **Bonjour only for the phrase, only on macOS**, through the system's `dns_sd` (`internal/pairing/bonjour_darwin.c`), not a Go mDNS library. A phone never browses or advertises (its codes carry the addresses), so the iOS build has no Bonjour code and no `NSBonjourServices` key. Windows and Linux have no phrase path yet (`PhraseAvailable` is false there).
- The receiving side opens the seal, shows a summary, and saves to the Keychain only after the user confirms.
- **QR payload:** `peli-pair:v1:<base64url>` of a fixed binary layout: version, expiry (Unix seconds), session id (16 bytes), account hash (16 bytes), `K` (32 bytes), the sender's ephemeral X25519 public key (32 bytes), port, then up to four IPv4/IPv6 addresses. About 140 bytes, a version 7 QR at error correction M.
- **iOS permissions:** `NSLocalNetworkUsageDescription` and `NSCameraUsageDescription` (macOS 15 also asks for Local Network: its Info.plist has the same description). The first LAN connection shows the Local Network prompt. A denial shows as an immediate "no route to host" to a private address; the scanner then says "Peli can't reach your other device. Turn on Local Network for Peli in Settings…" with a button to the app's page in Settings (`shell.OpenAppSettings`). The listening side can't tell a denial from nobody connecting: its code just runs out.
- **macOS:** an ad-hoc signed app that listens on the LAN may raise the firewall's "accept incoming connections?" prompt the first time it sends. That's checked on the user's Mac, and the Settings copy mentions it.

## Construction

### QR path (`K` is 256 bits from the QR)

"Shower" is the side showing the code (key pair `s, S`), "scanner" the side that scans it (`r, R`).

1. The scanner makes an ephemeral X25519 key pair and sends `POST /pair/<session>` with `R ‖ proof ‖ sealed request`, where `proof = HMAC-SHA256(HKDF(K, "peli-pair v1 proof"), session ‖ R)`. The request is `{device, account, bundle?}` (the bundle only when it pushes, in request mode); `account` is the scanner's own account hash.
2. The shower checks the proof (constant time), computes `key = HKDF-SHA256(ikm = K ‖ X25519(s, R), salt = session, info = "peli-pair v1 seal")`, opens the request, refuses a different account (403, and the code ends), and answers with the sealed `{device, bundle?}` (the bundle in offer mode).
3. Each sealed message is `nonce ‖ XChaCha20-Poly1305(key, nonce, json, aad)` with `aad = "peli-pair v1" ‖ direction ‖ mode ‖ session ‖ account hash ‖ S ‖ R`, so an answer can't pass for a request, and any change to the ciphertext, mode, session, account or either key fails the tag.
4. Refusals are plain JSON codes: 401 `refused` (a bad try), 403 `wrong_account`, 410 `used`/`expired`/`too_many_tries`.

All of it is `golang.org/x/crypto` (`chacha20poly1305`, `curve25519`, `hkdf`) and the standard library (`crypto/hmac`, `crypto/sha256`, `crypto/rand`).

### Phrase path (Mac to Mac only)

**Built (P1):** six words from EFF's short wordlist 1 (1,296 words of at most five letters, CC BY 3.0 US, credited in `internal/pairing/words.go`). The first word is the tag in the sender's Bonjour TXT record (`t=<index>`), so the receiving Mac finds it. The other five (about 51.7 bits) are the CPace password, with the context `("peli-pair receiver", "peli-pair sender", "peli-pair v1 phrase <tag>")`. `POST /phrase/start` carries CPace's `msgA` and answers `attempt id ‖ S ‖ account hash ‖ msgB`. `K = HKDF(CPace key, "peli-pair v1 phrase key")` then runs the QR path's steps 1–4 with the attempt id as the session. Each start is one guess, and three starts end the code.

The candidates as they were weighed (the original sketch was a 2,048-word list, 16 bits of tag and 50 of secret):

| | Construction | Offline attack by a passive same-Wi-Fi recorder | Dependencies |
|---|---|---|---|
| **P1** | **CPace** (a balanced PAKE, picked by the IRTF CFRG in 2020) over ristretto255, through `filippo.io/cpace` | **None**: each guess needs a live run against the sender, and three bad tries end the session | `filippo.io/cpace` + `filippo.io/edwards25519` (already in `go.sum`). By Go's former crypto lead, small, readable, but only pseudo-versions and an early draft of the spec |
| P2 | **SPAKE2** (as magic-wormhole uses for its short codes) | None, as P1 | No maintained Go package of standing (`schollz/pake` and `gospake2` are niche). Writing it over `edwards25519` is rolling our own crypto. Not recommended |
| P3 | **Noise `NNpsk0`**, the PSK = `Argon2id(phrase, salt = session tag, 64 MiB, 3 passes)` | **Yes**: the first handshake message's tag lets someone who recorded it test guesses offline, slowed only by Argon2id. 50 bits at about 10⁴ guesses a second (a GPU rig) is about 3,600 years for the whole space, so it holds, but the margin rests on the Argon2id cost (which the phone has to pay too) and the attacker's budget, not on the protocol | `golang.org/x/crypto` only (`argon2`, `curve25519`, `chacha20poly1305`, `hkdf`), optionally `github.com/flynn/noise` |
| P4 | **Turn the QR round**: the device with a camera always scans. When the Mac is the receiver, the *Mac* shows the QR (its addresses, `K`, its public key) and the phone scans it and **pushes** the bundle. The phrase is then needed only between two Macs (or with the camera denied), with P1 or P3 for that case | None on the QR legs | As the QR path. It changes the flow the ticket describes ("iPad → Mac with the phrase" becomes "the Mac shows a code, the iPad scans it") |

The user chose P4 with P1 for Mac to Mac. This changed the ticket's acceptance item "iPad → Mac with the phrase" to "iPad → Mac by scanning the Mac's code".

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

No Nuvio session, no debrid keys, no addon URLs: those already sync through Nuvio, or aren't Peli's. It never reaches the webview: Go's bound methods return only names and which services. `internal/pairing` builds it from `tracking.Export` (a package function, not a bound method, so the webview never sees a token) and applies it with `tracking.Adopt`, which writes the Keychain and the store's link exactly as a sign-in does, then `ImportSoon` for each profile.

## Matching profiles

- Both devices must be on the same Nuvio account (the account hash above).
- A profile matches by `NuvioIndex`. The receiver's summary lists each sent profile with the local profile it goes to.
- A sent profile with no local match (the receiver has fewer Nuvio profiles, or is on a local-only Guest) starts as "Skip", with every local non-kids profile to choose from. Guest is never matched by itself. Two sent profiles can't go to the same local one (the summary says so, and `Apply` refuses it).
- Kids profiles never send or receive.
- Picking a local profile that already has a connection shows "Replaces Kevin's SIMKL connection here"; confirming replaces it. A replaced SIMKL grant is not revoked (it may be the other device's own), and its queued scrobbles are dropped if the account differs.

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

- A new package, `internal/pairing`, in both builds (no cgo on iOS; `bonjour_darwin.c` is macOS only); new dependencies `filippo.io/cpace` and `github.com/gtank/ristretto255` (BSD), and `golang.org/x/crypto` becomes direct.
- A QR scanner in `internal/shell` (`ScanQR`, `CameraAccess`, `OpenAppSettings`): AVFoundation's `AVCaptureMetadataOutput`, because VisionKit's `DataScannerViewController` is Swift-only and the iOS build has no Swift. The desktop twins report no camera.
- `ios_boundary_test.go` lists `scanner_ios.m/.h` in `internal/shell`. E would add a call path into `nuvio/realtime.go` on iOS.
- Settings › Integrations gains an "Other devices" group on every platform (the Mac is a party to every direction).
- The receiver writes to the Keychain only. Nothing is written to Nuvio, SIMKL or AniList by pairing itself; the import that follows only adds watched marks, as any connect does.
