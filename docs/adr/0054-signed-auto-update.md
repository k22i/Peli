---
status: accepted
date: 2026-11-12
---

# Signed auto-update: Wails' updater, a signed feed on GitHub Releases, macOS first

#83 (F28) keeps installed copies of Peli up to date. A new version downloads in the background, Peli checks it, and it installs only when the user restarts Peli. It never installs while something is playing. A manual check in Settings asks before it downloads anything; the background check, which the device's settings allow, doesn't. `internal/updates` does it.

## Wails' updater, with Peli's rules on top

Wails v3 beta.28 has an updater (`pkg/updater`). It reads a feed, streams the download while hashing it, checks a signature against a key compiled into the app, unpacks a zip holding one `.app`, and swaps the bundle once the app has quit. The swap is done by a helper, which is Peli's own binary started again with `WAILS_UPDATER_HELPER*` variables set. The helper backs the old bundle up, puts the new one in place, restores the backup if that fails, and opens the new Peli. That's the hard part of an updater, and it's tested upstream, so Peli uses it rather than Sparkle (an Objective-C framework of its own, with its own window, and macOS only) or a swap of our own.

Peli adds rules that Wails leaves out:

- **Every release must be signed.** Wails installs a release that carries only a digest, or nothing at all, and checks a signature only when the feed includes one. `updates.signed` wraps Wails' `endpoint` provider and refuses any release without an `ed25519ph` signature of the right length (`ErrUnsigned`). It also refuses a size of 0 or over 150 MB, and cuts a download off at the size the feed gave.
- **The new app must be the release the feed named.** The signature covers the zip, but the feed's `version` field isn't signed. So after unpacking, Peli reads the new bundle's `CFBundleShortVersionString` and requires it to match the feed. A newer version number on an old (validly signed) zip can't downgrade anyone.
- **Same app, same team.** The new bundle's `CFBundleIdentifier` must match, `codesign --verify --deep --strict` must pass, and when the running copy has a Team ID, the new one must satisfy `anchor apple generic and certificate leaf[subject.OU] = "<team>"`. ADR-0053's keychain items trust Peli's designated requirement, so an update from a different team would make them prompt. An ad-hoc copy has no team to keep, so only the signature check applies to it.
- **Only a copy that can replace itself.** Updates are off (`State: off` with a `Reason`) for a build without a release version (`go run`, `wails dev`, `0.0.0-dev`), for an app outside a bundle or on a read-only volume (the DMG, or App Translocation's copy when Peli was opened from the download folder), and when Peli can't write to the bundle or the folder it's in. Settings › About says which, for example "Move Peli to your Applications folder to get updates."
- **Never during playback.** Nothing restarts by itself. "Restart to update" is in the top bar's pill and in Settings › About, and neither shows on the player screen. Go refuses `Restart` while a stream is loaded (`ErrPlaying`). The update toast waits until the player closes, and closes if one opens.
- **A manual check asks before it downloads.** "Check now" in Settings › About is a check: it looks, and when the feed names a release the status says it's available (`State: available`, with the version and notes) and nothing is downloaded. The row asks "Download Peli 0.2.0?" — a dialog, with "Not now" leaving a Download button in the row — and only `Download` starts it. The background check doesn't ask, since "Automatic updates" (`DeviceSettings.autoUpdate`) already says it may download by itself.
- **Said as soon as there's something to say.** A toast says "Peli 0.2.0 is available" the moment the feed names a release, then becomes "Peli 0.2.0 is ready" with a Restart button in place, on one id, once the download is checked. It stays until it's used or swiped away, so the update is one click rather than a trip to Settings.

`main.go` calls `updater.HandleHelperMode()` straight after `plugins.ServeChild()`. `application.New` calls it too, but only after everything above it in `main` has run: moving Sinag's folders, opening the keychain, and starting the anime list's download.

## The feed

`peli-update.json` is attached to each GitHub release. Peli reads `https://github.com/k22i/Peli/releases/latest/download/peli-update.json`, which GitHub redirects to the newest release's copy. It's Wails' `endpoint` manifest:

```json
{
  "schemaVersion": 1,
  "version": "0.2.0",
  "name": "Peli 0.2.0",
  "notes": "…Markdown…",
  "publishedAt": "2026-…Z",
  "artifacts": [
    { "url": "https://github.com/k22i/Peli/releases/download/v0.2.0/Peli-0.2.0-arm64.zip",
      "platform": "darwin", "arch": "arm64", "size": 26000000,
      "signatureAlgo": "ed25519ph", "signature": "…base64…" }
  ]
}
```

Artifact URLs name the version, so a release published between the check and the download can't swap the file. `go run ./tools/updates feed` writes the feed. It signs each zip's SHA-512 with `PELI_UPDATE_KEY` and refuses a key that isn't the private half of `updates.PublicKey`. `go run ./tools/updates verify` checks a feed and its files the way the app does.

**The key.** Ed25519. The public half is `updates.PublicKey`, compiled in. The private half (a base64 seed) is in the login keychain as "Peli update signing" (made 2026-11-12) (`security find-generic-password -s "Peli update signing" -w`), and #80 puts it in CI's secrets as `PELI_UPDATE_KEY`. If `PublicKey` is ever empty, updates are off and `tools/updates` refuses to sign. The pair was made with:

```sh
priv=$(go run ./tools/updates keygen 2>pub.txt) &&
  security add-generic-password -s "Peli update signing" -a PELI_UPDATE_KEY -w "$priv" &&
  unset priv && cat pub.txt && rm pub.txt   # → updates.PublicKey
```

Wails' updater takes one key. To rotate it, ship one release signed with the old key whose app trusts the new one.

**The repository is private.** GitHub serves a private repo's release assets only with a token, and Peli has none, so a check gets a 404, which Wails reads as "up to date". Before the first release goes out, either the repo becomes public or the feed and zips move somewhere public (a releases-only repo, for example). Then build with `-ldflags "-X github.com/k22i/Peli/internal/updates.FeedURL=…"`, or change `FeedURL`. `$PELI_UPDATE_URL` overrides it at run time, for trying an update locally.

## macOS: a zip of the notarized app

The DMG is for the first install. An update is `Peli-<version>-<arch>.zip`: the notarized, stapled `Peli.app` from the same release run, zipped by `dist.sh zip` with `ditto -c -k --keepParent` and without resource forks or extended attributes (the signature doesn't use them). `wails3 task darwin:release` now makes the zip after notarizing the app, and `darwin:package:zip` makes an unnotarized one for local tries. Peli's own download doesn't get the quarantine attribute, so Gatekeeper doesn't ask again, and the stapled ticket is inside the bundle anyway.

Release builds now stamp `appinfo.Version` from `Info.plist` (`-X …/appinfo.Version`). Before this they all said `0.0.0-dev`. That was harmless for User-Agents, but updates compare against it.

**When it runs.** One minute after launch, so the check never slows startup, then every six hours (or an hour after a failure). A 15-minute tick checks the clock, so the schedule survives the Mac sleeping. Settings › About › "Automatic updates" (`DeviceSettings.autoUpdate`, on by default) turns the background checks off. "Check now" still works, and it asks before downloading: the automatic path checks and downloads in one go, a manual one stops at `available` and waits for `Download`.

**Tried end to end on 2026-11-12** (M1 Pro, ad hoc): a 0.1.0 `Peli.app` packaged with `darwin:package`, a 0.1.1 zip from `darwin:package:zip` (24.3 MB), and a feed signed with a throwaway key, served on loopback through `$PELI_UPDATE_URL`. The check, download, signature, version and bundle checks passed. On Restart, the helper backed up the bundle, swapped it on the first try, removed the backup and opened 0.1.1, whose signature verified. Earlier in the same run, a build whose Taskfile left the version empty came up `off` (development), as it should.

## Windows and Linux

Windows gets an install strategy with its installer (#77). Wails' helper renames the running `.exe` aside and puts the new one in place, which needs a folder the user can write to. An NSIS install to Program Files isn't one, so #77 either installs per user (`%LOCALAPPDATA%\Programs\Peli`) or runs the new installer silently. Until then `updates` reports `unsupported` on Windows. Linux is deferred with the rest of its work (#103): AppImage and Flatpak have their own update mechanisms.

## What we give up

- **No install on quit.** Wails' helper always reopens the app after swapping it, and reopening Peli after the user quit it would be wrong. A ready update that the user never restarts into is downloaded again next launch (about 25 MB).
- **Each update is a full download.** There are no deltas.
- **Wails' updater is beta.** Its helper protocol and manifest could change between betas. `updates.signed` and `installed.Check` don't depend on its internals, but bump Wails with an update test: `internal/updates`' tests run a signed zip through Wails' updater, and the end-to-end try above is the check of the helper.

## Revisit when

- The repo goes public, or the feed moves: change `FeedURL`.
- #77 picks Windows' installer: add `installed_windows.go`.
- Wails' updater gets install-on-quit, or its own "signature required" switch: drop ours.
