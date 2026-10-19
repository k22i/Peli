# Cove

A desktop app for Windows, macOS and Linux that plays streams from Stremio-compatible addons, with library and watch progress synced through Nuvio. Built with [Wails v3](https://v3.wails.io/) (Go) and React, and plays video in-window with libmpv.

Cove is early in development and not usable yet. The plan and decisions so far are in [`docs/m0-gate-review.md`](docs/m0-gate-review.md) and [`docs/adr/`](docs/adr/).

## Disclaimer

Cove is a player. It bundles no addons and hosts, indexes or links to no content. Everything it plays comes from addons that you choose to install, and you are responsible for making sure you have the right to access that content where you live.

Cove is not affiliated with Stremio or Nuvio.

## Building

You need:

- Go 1.25 or later
- Node.js 22.18 or later (or 24.11+, or 26+), and [pnpm](https://pnpm.io/installation) 11 (`corepack enable` picks up the version pinned in `frontend/package.json`)
- The Wails CLI, pinned to the version in `go.mod`:

  ```sh
  go install github.com/wailsapp/wails/v3/cmd/wails3@v3.0.0-beta.28
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

UI components come from the coss ui registry and live in `frontend/src/components/ui/`. Add one with `pnpm dlx shadcn@4.21.4 add @coss/<name>` (for example `@coss/dialog`), and add only what you use. The theme tokens are the coss CSS variables in `frontend/src/index.css`.

### Local data

Profiles, library, progress, watched items, addons, sync state and the persisted query cache live in one [bbolt](https://github.com/etcd-io/bbolt) file, `Cove/cove.db` in the OS app-data directory: `~/Library/Application Support` on macOS, `%LOCALAPPDATA%` on Windows and `$XDG_DATA_HOME` (usually `~/.local/share`) on Linux. Set `COVE_DATA_DIR` to use another directory, for example a throwaway one while developing. The store is `internal/store` ([ADR-0006](docs/adr/0006-local-store-bbolt.md)); run its tests with `go test ./internal/...`.

Tokens and keys (Nuvio session, Trakt, debrid) are never in that file. They live in the OS keychain under the service `Cove`: the macOS Keychain, Windows Credential Manager, or the Secret Service on Linux (gnome-keyring or KWallet must be running to sign in). The code is `internal/secrets` ([ADR-0007](docs/adr/0007-secrets-in-os-keychain.md)), and the frontend uses `frontend/src/lib/secrets.ts`. `go test` uses a mock keychain; `COVE_KEYCHAIN_TEST=1 go test ./internal/secrets` runs the tests against your real one, under a separate service name, and removes what they write.

pnpm refuses package versions published less than 7 days ago (`minimumReleaseAge` in `frontend/pnpm-workspace.yaml`), so pin dependencies to versions at least a week old.

### CI

[`.github/workflows/ci.yml`](.github/workflows/ci.yml) runs on every PR and push to `main`: frontend format, lint, type check, tests and build; Go `gofmt`, vet and tests (with the real-keychain tests) on Windows, macOS arm64, macOS Intel and Linux; and a production build per OS, uploaded as `cove-<os>-<arch>` artifacts (kept 14 days). PRs skip the Intel Mac build to save macOS minutes. Run it by hand with `dev-smoke` ticked to also check that `wails3 dev` starts the app on Windows and Linux.

## Layout

| Path | What |
|---|---|
| `main.go` | App entry point |
| `internal/` | Go packages, including the Wails services the frontend calls |
| `frontend/` | React + TypeScript UI, built with Vite+ |
| `build/` | Per-platform build and packaging config; app metadata is in `build/config.yml` |
| `docs/` | Gate review, ADRs and spike findings |
| `spikes/` | Throwaway M0 spike code, not part of the app |

## Licence

MIT. See [ADR-0003](docs/adr/0003-mit-app-with-our-own-lgpl-libmpv.md) for how that holds with libmpv.
