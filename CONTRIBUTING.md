# Contributing to Sinag

Sinag is MIT-licensed. Contributions are accepted under the same licence.

## Clean-room rule for Nuvio

Sinag talks to Nuvio's hosted backend, but it must not copy Nuvio's code.

- **NuvioMobile is GPL-3.** Never read it, copy from it or port it. Code derived from it would force Sinag to GPL-3.
- **nuvio-web has no licence.** Without a licence, all rights are reserved: do not read or copy it either.
- **The contract comes from observed behaviour and the Apache-2.0 `NuvioMedia/self-host` schema.** Re-implement from that, and write down what you observed in [docs/spikes/nuvio-backend.md](docs/spikes/nuvio-backend.md).

If you have already read GPL or unlicensed Nuvio code for a part of Sinag, say so in the issue before you work on that part, so someone else can take it.

## Dependencies

Every dependency, Go or npm, must be under a permissive licence: MIT, Apache-2.0, BSD, ISC, OFL-1.1 (fonts), MPL-2.0, Unlicense or similar. No GPL, AGPL or LGPL code is linked into Sinag, and `go run ./tools/notices -audit` fails if one appears.

After you add, remove or update a dependency, regenerate the notices and commit the result:

```sh
cd frontend && pnpm install && cd ..
go run ./tools/notices
```

This rewrites `THIRD_PARTY_NOTICES.md` and `internal/licences/notices.json` (shown in Settings › About › Licences). CI fails if they are stale.

## libmpv

libmpv is the one LGPL component, and it is how the app stays MIT ([ADR-0003](docs/adr/0003-mit-app-with-our-own-lgpl-libmpv.md)):

- Every package that bundles libmpv ships **our own LGPL build** (`-Dgpl=false`, FFmpeg without `--enable-gpl` or `--enable-nonfree`), **dynamically linked** so users can swap it.
- Never bundle shinchiro's, Homebrew's or Debian's builds. They are GPL.
- The `.deb` depends on the distro's `libmpv2` and bundles nothing.
- `go run ./tools/notices -audit -bundle <dir>` scans a release bundle for GPL or non-free FFmpeg builds. Run it on every package before release.

## Before you open a PR

Run what CI runs: `cd frontend && pnpm check && pnpm test` and `go vet ./internal/... && go test ./internal/...`.
