---
status: accepted
date: 2026-10-19
---

# Secrets live in the OS keychain through go-keyring, with no file fallback

**OS keychain, through [go-keyring](https://github.com/zalando/go-keyring).** Cove keeps the Nuvio session, Trakt tokens and debrid keys in the macOS Keychain, Windows Credential Manager or the Linux Secret Service (#15). They are never written to a file: not `cove.db` (ADR-0006), not the persisted query cache, not webview storage. The Go package is `internal/secrets`, and the frontend reaches it through a Wails service.

## Why

- **It's what the OS is for.** The keychain encrypts items at rest and ties them to the user's login, and it's where users and admins expect app credentials to be. The NFR is "never in plain files".
- **One library, three OSes, no cgo.** go-keyring calls `/usr/bin/security` on macOS, `CredWrite`/`CredRead` on Windows, and the Secret Service over D-Bus on Linux. Wails' own module already required it, so the only new module is the small `danieljoos/wincred`. The alternative, [99designs/keyring](https://github.com/99designs/keyring), is heavier and includes an encrypted-file backend that we'd have to keep turned off.
- **No plaintext fallback.** On Linux with no Secret Service running, every call fails with `ErrUnavailable` and a message saying to install and start gnome-keyring or KWallet. Signing in needs a keychain. Guest mode doesn't need one.

## What we give up

- **On macOS, the item trusts `security`, not Cove.** Because go-keyring writes through Apple's command-line tool, the item's access list names `/usr/bin/security`. Any process running as the user can read Cove's items with `security find-generic-password -s Cove -w`, with no prompt. Malware running as the user can already read browser cookies and most app data, so this weakens a defence-in-depth layer rather than opening a new hole. Items are still encrypted at rest and never sit in a file.
- **A 2,560-byte cap per value on every OS.** That's Windows Credential Manager's limit, applied everywhere so a value that works on one OS can't fail on another. A Supabase session goes in as two keys, access token (~1 KB) and refresh token, not one JSON blob.
- **Keys are a fixed shape.** They are lowercase dot-separated names (`nuvio.refresh-token`, `debrid.torbox`), so nothing derived from user input or a URL can become a keychain entry by accident.

## Revisit when

**Cove is signed with a Developer ID (#78).** Then replace the macOS backend with direct Security.framework calls (`SecItemAdd` / `SecItemCopyMatching`, about 80 lines of cgo) so items trust Cove's signature, and other processes have to ask. We don't do this now because Cove is ad-hoc signed: macOS would identify it by the binary's hash, which changes with every build, so every update or rebuild would prompt "Allow Cove to access the keychain?". The `internal/secrets` API stays the same, and existing items can be migrated with one read and rewrite on first launch.
