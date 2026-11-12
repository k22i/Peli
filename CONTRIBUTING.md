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

## Before you open a PR

Run what CI runs: `cd frontend && pnpm check && pnpm test` and `go vet ./internal/... && go test ./internal/...`.
