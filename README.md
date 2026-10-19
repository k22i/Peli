# Cove

A desktop app for Windows, macOS and Linux that plays streams from Stremio-compatible addons, with library and watch progress synced through Nuvio. Built with [Wails v3](https://v3.wails.io/) (Go) and React, and plays video in-window with libmpv.

Cove is early in development and not usable yet. The plan and decisions so far are in [`docs/m0-gate-review.md`](docs/m0-gate-review.md) and [`docs/adr/`](docs/adr/).

## Disclaimer

Cove is a player. It bundles no addons and hosts, indexes or links to no content. Everything it plays comes from addons that you choose to install, and you are responsible for making sure you have the right to access that content where you live.

Cove is not affiliated with Stremio or Nuvio.

## Building

You need:

- Go 1.25 or later
- Node.js 22 or later, with npm
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

## Layout

| Path | What |
|---|---|
| `main.go` | App entry point |
| `frontend/` | React + TypeScript UI, built with Vite |
| `build/` | Per-platform build and packaging config; app metadata is in `build/config.yml` |
| `docs/` | Gate review, ADRs and spike findings |
| `spikes/` | Throwaway M0 spike code, not part of the app |

## Licence

MIT. See [ADR-0003](docs/adr/0003-mit-app-with-our-own-lgpl-libmpv.md) for how that holds with libmpv.
