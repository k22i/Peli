# Peli

A desktop app for Windows, macOS and Linux that plays streams from Stremio-compatible addons, with library and watch progress synced through Nuvio. Built with [Wails v3](https://v3.wails.io/) (Go) and React, and plays video in-window with libmpv.

Peli is early in development and not usable yet. The plan and decisions so far are in [`docs/m0-gate-review.md`](docs/m0-gate-review.md) and [`docs/adr/`](docs/adr/).

## Disclaimer

Peli is a player. It bundles no addons and hosts, indexes or links to no content. Everything it plays comes from addons that you choose to install, and you are responsible for making sure you have the right to access that content where you live.

Peli is not affiliated with Stremio or Nuvio.

## Building

You need:

- Go 1.25 or later
- Node.js 22.18 or later (or 24.11+, or 26+), and [pnpm](https://pnpm.io/installation) 11 (`corepack enable` picks up the version pinned in `frontend/package.json`)
- The Wails CLI, pinned to the version in `go.mod`:

  ```sh
  go install github.com/wailsapp/wails/v3/cmd/wails3@v3.1.0
  ```

- Platform dependencies:
  - **macOS:** Xcode Command Line Tools (`xcode-select --install`)
  - **Windows:** WebView2 (built into Windows 11)
  - **Linux:** GTK 4 and WebKitGTK 6, for example `libgtk-4-dev libwebkitgtk-6.0-dev` on Debian or Ubuntu

  `wails3 doctor` checks what's missing.

Then, from the repo root:

```sh
wails3 dev     # run with hot reload
wails3 build   # production build into bin/
```

`wails3 package` builds the platform installer.

Keep the Wails CLI, the Go module (`go.mod`) and `@wailsio/runtime` (`frontend/package.json`) on the same version, and upgrade them together.

### Frontend

The frontend uses [Vite+](https://viteplus.dev/) (Vite, Vitest, Oxlint and Oxfmt), React 19, TypeScript 7, TanStack Router and Query, Tailwind CSS, and [coss ui](https://coss.com/ui/docs/get-started) components (on Base UI). From `frontend/`:

```sh
pnpm install
pnpm bindings    # generate TypeScript bindings for the Go services (needs wails3)
pnpm check       # format check, lint and type check in one pass
pnpm lint        # Oxlint, type-aware
pnpm typecheck   # type check only
pnpm fmt         # format with Oxfmt
pnpm test        # Vitest + React Testing Library
```

`frontend/bindings/` is generated (by `pnpm bindings`, `wails3 dev` or `wails3 build`) and not committed; generate it before the first `typecheck` or `test`. Frontend code imports them as `@bindings/<package>`, for example `@bindings/appinfo`. Routes are files in `frontend/src/routes/`; the router plugin regenerates `src/routeTree.gen.ts` on `dev` and `build`.

Addon requests (manifests, catalogs, metas, streams, subtitles) all go through the typed client in `frontend/src/lib/addon-protocol/` ([ADR-0023](docs/adr/0023-addon-protocol-client.md)); `internal/addons` fetches for addons that send no CORS headers. Its tests use recorded answers from public addons. `pnpm record:addons` re-records them, and `PELI_LIVE_ADDONS=1 pnpm exec vp test run src/lib/addon-protocol/live.test.ts` runs one test against the live addons.

UI components come from the coss ui registry and live in `frontend/src/components/ui/`. Add one with `pnpm dlx shadcn@4.21.4 add @coss/<name>` (for example `@coss/dialog`), and add only what you use. The theme tokens are the coss CSS variables in `frontend/src/index.css`.

### Local data

Profiles, library, progress, watched items, addons, sync state and the persisted query cache live in one [bbolt](https://github.com/etcd-io/bbolt) file, `Peli/peli.db` in the OS app-data directory: `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows and `$XDG_DATA_HOME` (usually `~/.local/share`) on Linux. Set `PELI_DATA_DIR` to use another directory, for example a throwaway one while developing. The store is `internal/store` ([ADR-0006](docs/adr/0006-local-store-bbolt.md)); run its tests with `go test ./internal/...`.

Tokens and keys (Nuvio session, SIMKL and AniList, the TMDB key) are never in that file. They live in the OS keychain under the service `Peli`: the macOS Keychain, Windows Credential Manager, or the Secret Service on Linux (gnome-keyring or KWallet must be running to sign in). The code is `internal/secrets` ([ADR-0007](docs/adr/0007-secrets-in-os-keychain.md)), and the frontend uses `frontend/src/lib/secrets.ts`. `go test` uses a mock keychain; `PELI_KEYCHAIN_TEST=1 go test ./internal/secrets` runs the tests against your real one, under a separate service name, and removes what they write.

pnpm refuses package versions published less than 7 days ago (`minimumReleaseAge` in `frontend/pnpm-workspace.yaml`), so pin dependencies to versions at least a week old.

### SIMKL and AniList

Settings › Integrations connects a profile to SIMKL and AniList ([ADR-0042](docs/adr/0042-simkl-and-anilist.md)). The code is `internal/tracking`, with the clients in `internal/simkl` and `internal/anilist`. Peli's registered apps are the client ids in `internal/tracking/tracking.go`; to use your own, register a SIMKL AUTH V2 app of the "TV, devices & command line" kind (Peli only uses the device flow, so it needs no redirect URL) and an AniList app with the redirect URL `http://127.0.0.1:47613/anilist`, and set `PELI_SIMKL_CLIENT_ID` and `PELI_ANILIST_CLIENT_ID`.

### Nuvio plugins

Nuvio's JS plugins run in a sandbox in `internal/plugins`, one child process per call ([ADR-0043](docs/adr/0043-plugin-sandbox.md)). They are off until you turn them on in Settings › Plugins, which also installs plugin repositories by their manifest address and syncs the list with Nuvio ([ADR-0047](docs/adr/0047-plugin-management.md)); kids profiles never run them. `go run ./tools/plugins -manifest <url> -tmdb 550 -type movie` (or `-file plugin.js`) runs plugins in the same sandbox and reports what each answered. `PELI_PLUGIN_LOG=1` passes the plugins' console output to the log.

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every PR and push to `main`: frontend format, lint, type check, tests and build; Go `gofmt`, vet and tests (with the real-keychain tests) on Windows, macOS arm64, macOS Intel and Linux; and a production build per OS, uploaded as `peli-<os>-<arch>` artifacts (kept 14 days). PRs skip the Intel Mac build to save macOS minutes. Run it by hand with `dev-smoke` ticked to also check that `wails3 dev` starts the app on Windows and Linux.

## Layout

| Path | What |
|---|---|
| `main.go` | App entry point |
| `internal/` | Go packages, including the Wails services the frontend calls |
| `frontend/` | React + TypeScript UI, built with Vite+ |
| `build/` | Per-platform build and packaging config; app metadata is in `build/config.yml` |
| `tools/notices/` | Generates the third-party notices and audits releases for GPL-only parts |
| `tools/plugins/` | Runs Nuvio plugins in Peli's sandbox and reports what each answered |
| `docs/` | Gate review, ADRs and spike findings |
| `spikes/` | Throwaway M0 spike code, not part of the app |

## Licence

MIT: see [`LICENSE`](LICENSE). The software Peli includes is listed in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md) (also in Settings › About › Licences). [ADR-0003](docs/adr/0003-mit-app-with-our-own-lgpl-libmpv.md) explains how MIT holds with libmpv, and [CONTRIBUTING.md](CONTRIBUTING.md) has the rules for dependencies and for Nuvio.

`go run ./tools/notices` regenerates the notices; `go run ./tools/notices -audit [-bundle <dir>]` fails on GPL-only dependencies or a GPL or non-free libmpv/FFmpeg in a release bundle. CI runs both.
