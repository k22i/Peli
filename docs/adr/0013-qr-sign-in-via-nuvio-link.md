---
status: accepted
date: 2026-10-20
---

# QR sign-in uses Nuvio's device login: a QR code to nuvio.tv/link and a short code, polled in Go

Peli signs in without a password typed on the desktop (#21) through Nuvio's newer device login, not the `start_tv_login_session` flow the M0 spike tested. **Go** calls `start_device_login_session`, keeps the device code and nonce, and gives the screen only what it shows: a QR code for `https://nuvio.tv/link?code=XB92CT`, the six-character code, the link page and the expiry. The user scans the QR with their phone's camera, or types the code at nuvio.tv/link on any device, signs in to Nuvio there and approves "Peli on <computer name>". **Go polls** `poll_tv_login_session` at the backend's interval (3 s), and backs off from 6 s up to 30 s while the backend can't be reached. On approval it calls `tv-logins-exchange` and signs in the way email does: one shared `signIn` keeps the session in the keychain and links the profiles, keeps nothing if a step fails, and ends the exchanged session on Nuvio.

- **The screen draws the QR code.** Go encodes it with `rsc.io/qr` (BSD-3) and sends the dark modules as an SVG path. There's no JS QR library. The tile is black on white in both themes.
- **Codes last 5 minutes.** The screen counts down to `expires_at` and shows **The code expired** with **New code** when it reaches zero or Go says so. **New code** is always one click away, and starting a new code ends the old wait.
- **The wait is a cancellable call.** `WaitQRSignIn(code)` blocks until approval or expiry. The frontend cancels it when it leaves the screen or gets a new code, and Wails cancels the Go context. The code stays valid, so a second wait for it (React's StrictMode mounts twice) picks up where the first stopped, and only one wait polls at a time.

## Why

- **Any phone can approve.** The M0 flow's `web_url` was for the Nuvio phone app. nuvio.tv/link is Nuvio's own "Link a device" web page, so an iPhone without the Nuvio app works through Safari, and so does a browser on the same computer. The user who asked for this ticket has exactly that setup.
- **Nuvio's newest apps use it.** It came in self-host migration 11 (2026-10-16), was live on api.nuvio.tv by 2026-10-20, and keeps polling and the exchange unchanged. The short code gives the ticket's "QR + short code" in one step.
- **Secrets stay in Go (ADR-0008).** The exchange returns tokens, and the nonce is what proves the poll comes from the device that started it, so neither reaches the webview.
- **A live check covers it end to end.** `TestLiveDeviceLogin` starts a login on live, approves it with a password session standing in for the phone, polls, exchanges, reads the profiles and signs both sessions out.

## What we give up

- **The old `start_tv_login_session` flow isn't used.** A self-hosted backend from before migration 11 has no `start_device_login_session`, and QR sign-in fails there with an error; email still works.
- **The link page is fixed to nuvio.tv/link.** A custom backend's web app may live elsewhere. When #28 adds custom backend URLs, it needs a link URL setting too.
- **The computer's name goes to Nuvio.** "Peli on" plus the host name (without `.local`) is stored with the login, so the phone can show which device is asking. It falls back to the OS name.
- **Not tested with the Nuvio phone app's own scanner.** Whether the app scans `/link` URLs as it did `/tv-login` ones is unknown. The phone camera and nuvio.tv/link are what Peli tells the user to use.

## Revisit if

Nuvio retires `start_device_login_session` or `/link`, or #28 adds custom backends.
