# Contributing to Peli

Peli is MIT-licensed. Contributions are accepted under the same licence.

## Clean-room rule for Nuvio

Peli talks to Nuvio's hosted backend, but it must not copy Nuvio's code.

- **NuvioMobile is GPL-3.** Never read it, copy from it or port it. Code derived from it would force Peli to GPL-3.
- **nuvio-web has no licence.** Without a licence, all rights are reserved: do not read or copy it either.
- **The contract comes from observed behaviour and the Apache-2.0 `NuvioMedia/self-host` schema.** Re-implement from that, and write down what you observed in [docs/spikes/nuvio-backend.md](docs/spikes/nuvio-backend.md).

If you have already read GPL or unlicensed Nuvio code for a part of Peli, say so in the issue before you work on that part, so someone else can take it.

## Dependencies

Every dependency, Go or npm, must be under a permissive licence: MIT, Apache-2.0, BSD, ISC, OFL-1.1 (fonts), MPL-2.0, Unlicense or similar. No GPL, AGPL or LGPL code is linked into Peli, and `go run ./tools/notices -audit` fails if one appears.

After you add, remove or update a dependency, regenerate the notices and commit the result:

```sh
cd frontend && pnpm install && cd ..
go run ./tools/notices
```

This rewrites `THIRD_PARTY_NOTICES.md` and `internal/licences/notices.json` (shown in Settings › About › Licences). CI fails if they are stale.

Release builds use `-tags production,nosqlite`: `nosqlite` keeps anacrolix/torrent's SQLite store, whose adapter module has no licence, out of the binary ([ADR-0040](docs/adr/0040-torrent-streaming.md)). The Taskfiles pass it, and a production build without it doesn't compile.

## libmpv

libmpv is the one LGPL component, and it is how the app stays MIT ([ADR-0003](docs/adr/0003-mit-app-with-our-own-lgpl-libmpv.md)):

- Every package that bundles libmpv ships **our own LGPL build** (`-Dgpl=false`, FFmpeg without `--enable-gpl` or `--enable-nonfree`), **dynamically linked** so users can swap it.
- Never bundle shinchiro's, Homebrew's or Debian's builds. They are GPL.
- Our build is in [`build/libmpv`](build/libmpv/README.md) ([ADR-0041](docs/adr/0041-our-libmpv-build.md)), and CI's macOS jobs use it. Homebrew's mpv is fine for local development: `wails3 package` warns that such a bundle can't ship.
- The `.deb` depends on the distro's `libmpv2` and bundles nothing.
- `go run ./tools/notices -audit -bundle <dir>` scans a release bundle for GPL or non-free FFmpeg builds. Run it on every package before release.

## macOS release

One DMG per architecture, signed with the hardened runtime and notarized ([ADR-0053](docs/adr/0053-macos-packaging.md)). Users open it and drag Peli onto Applications.

- `wails3 task darwin:package:dmg` builds `bin/Peli.app` and `bin/Peli-<version>-<arch>.dmg` for this Mac's architecture (or pass `ARCH=amd64`), signed ad hoc. That is enough to try the app locally, and CI builds the same thing. It fails if the DMG is over 60 MB.
- `wails3 task darwin:release ARCH=arm64` (then `ARCH=amd64`) builds against `build/libmpv/.work/libmpv-macos-<arch>` (or `LIBMPV=<dir>`), signs with your Developer ID, notarizes and staples the app, then the DMG. Either Mac builds both architectures.
- One-time setup: join the Apple Developer Program, create a **Developer ID Application** certificate in Xcode (Settings › Accounts › Manage Certificates) or on developer.apple.com, and check that `security find-identity -v -p codesigning` lists it. Then run `xcrun notarytool store-credentials peli-notary` with an app-specific password or an App Store Connect API key, and export `PELI_SIGN_IDENTITY="Developer ID Application: <name> (<TEAMID>)"` and `PELI_NOTARY_PROFILE=peli-notary`. `build/darwin/dist.sh` lists the CI variables.
- A Developer ID build moves the keychain items to its own signature on first launch. After that, a development build on the same Mac asks once to use them (ADR-0053).

### Updates

Installed copies update from `peli-update.json` on the latest GitHub release ([ADR-0054](docs/adr/0054-signed-auto-update.md)). `darwin:release` also writes `bin/Peli-<version>-<arch>.zip`, the update. Sign the feed with the release key from the keychain, and attach it and both zips to the release:

```sh
export PELI_UPDATE_KEY=$(security find-generic-password -s "Peli update signing" -w)
go run ./tools/updates feed -version 0.2.0 -notes notes.md -out bin/peli-update.json \
  -base https://github.com/k22i/Peli/releases/download/v0.2.0/ \
  darwin/arm64=bin/Peli-0.2.0-arm64.zip darwin/amd64=bin/Peli-0.2.0-x86_64.zip
go run ./tools/updates verify bin/peli-update.json darwin/arm64=bin/Peli-0.2.0-arm64.zip
```

To try an update locally: package a copy, then bump `Info.plist`'s version and run `wails3 task darwin:package:zip`. Sign a feed whose `-base` is `http://127.0.0.1:<port>/`, serve the folder, and start the older copy with `PELI_UPDATE_URL=http://127.0.0.1:<port>/peli-update.json`. Development builds (`0.0.0-dev`) never update.

### On CI

`.github/workflows/release.yml` (#80) does the whole thing for Apple silicon when a `v*` tag is pushed:

```sh
git tag -a v0.2.0 -m "Peli 0.2.0" && git push origin v0.2.0
```

It fails early if the tag doesn't match `build/darwin/Info.plist`'s `CFBundleShortVersionString`, so bump that (and `build/config.yml`'s two versions) and commit before tagging. It builds libmpv for arm64, releases it (`wails3 task darwin:release`, or the ad-hoc path below), audits the bundle, signs the feed, and creates a **draft** release with the DMG, the zip and `peli-update.json`. The Intel (`amd64`) build is commented out in `release.yml`, `libmpv` included, to keep a release short: uncomment its entries and the feed's `darwin/amd64` artifact to ship both again.

Publishing the draft is what turns auto-update on: Peli reads `/releases/latest/download/peli-update.json`, and GitHub's "latest" skips drafts and pre-releases. A private repo serves no assets without a token and Peli has none ([ADR-0054](docs/adr/0054-signed-auto-update.md)), so the repository has to be public before installed copies can update.

Secrets, in Settings › Secrets and variables › Actions: `PELI_SIGN_CERT_P12` (the Developer ID Application certificate exported as `.p12`, base64) and `PELI_SIGN_CERT_PASSWORD`, `PELI_SIGN_IDENTITY`, `PELI_NOTARY_KEY` (the App Store Connect API key's `.p8` contents), `PELI_NOTARY_KEY_ID`, `PELI_NOTARY_ISSUER`, and `PELI_UPDATE_KEY` (ADR-0054's key: `security find-generic-password -s "Peli update signing" -w`).

#### Without an Apple Developer account

None of the six signing and notarization secrets are needed to ship and update Peli — only to make the *first* download clean. Set the repository **variable** `PELI_ADHOC=true` (Settings › Secrets and variables › Actions › Variables) and the same tag builds the same two artifacts, ad hoc signed, with no notarization. `dist.sh check` passes them, and `PELI_UPDATE_KEY` is still required: Peli refuses an unsigned feed whatever signed the app.

Updates work. `pkg/updater` verifies a download with `codesign --verify --deep --strict`, which an ad-hoc bundle passes, and `internal/updates` skips the Team-ID anchor for a copy that has none (`installed_darwin.go:77`). And an update Peli downloads itself is not quarantined, so Gatekeeper doesn't see it (ADR-0054).

What it costs:

- **The first install.** A DMG from a browser is quarantined, and macOS 15+ blocks an unnotarized app until the user allows it in System Settings › Privacy & Security (ADR-0053). The release notes say so.
- **`disable-library-validation`.** With no Team ID, dyld refuses to load libmpv, so ad-hoc bundles carry that entitlement; `dist.sh check` refuses it on a Developer ID build (ADR-0053).
- **The keychain, after every update.** An ad-hoc copy can't use the direct Security.framework path, so items prompt again each time, because its signature changes with every build (ADR-0053).

The two modes mix in one direction only: an ad-hoc copy accepts a later notarized release, a notarized copy refuses an ad-hoc one. So ad hoc first, Developer ID later, works.

## Before you open a PR

Run what CI runs: `cd frontend && pnpm check && pnpm test` and `go vet ./internal/... && go test ./internal/...`.
