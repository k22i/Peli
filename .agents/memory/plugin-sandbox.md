---
name: plugin-sandbox
description: "How Nuvio JS plugins run (#56, ADR-0043): internal/plugins child process per call, host API, limits, SINAG_DEV_PLUGINS, StreamSource key/name/kind, tools/plugins, goja pin; read before #57, #58, #65 or touching the picker's sources"
metadata:
  type: project
---

Plugins (#56, ADR-0043) are `internal/plugins`. Each `getStreams` call is a fresh goja runtime in a **child process of Sinag's own binary** (`SINAG_PLUGIN_SANDBOX=1`; `main` calls `plugins.ServeChild()` first, and so does the package's `TestMain`). The host API is ours: `js/prelude.js` (fetch, Headers, timers, TextEncoder…, `require` allow-list), `js/cheerio.js` over `html.go` (x/net/html + cascadia), and `js/crypto-js.js` over `crypto.go`. Limits are in `DefaultLimits` (45 s, 256 MiB, 200 fetches). fetch refuses private and loopback addresses at dial time (`Limits.PrivateNetwork` is for tests only).

**Why:** the ticket asks for no file or process access and per-call time and memory limits. goja's interrupt can't stop a regexp or one huge allocation, so the process is what makes the limits hard. Nuvio's runtime is GPL, so the API was written from a survey of 489 community plugins.

**How to apply:**
- Frontend: `lib/plugins.ts` (`pluginStreamsQuery`, `toStream`, `pluginQuery` by TMDB id via `useTmdbId` in `lib/tmdb.ts`). `StreamSource` is now `{key, name, kind, …}` and `StreamSlice.source`, not `.addon`. `useStreamChoices` merges `usePluginSources` and returns `refresh`, which the picker and the player's switcher pass to `resolvePick`.
- #57: `Plugins.Installed()` is the stand-in list: empty unless `SINAG_DEV_PLUGINS=<manifest URL>`. Replace it with the stored, synced list (Nuvio `plugins` table, `uses_primary_plugins`), keep plugins off by default, and pass per-plugin `Settings` (SCRAPER_SETTINGS). `ParseManifest` takes both manifest shapes.
- Route tests that render the picker or the player must mock `@bindings/plugins` (`Installed`, `Streams` with `cancel`).
- The auto-mode classifier blocked running third-party plugin code (2026-11-04). Only our own `testdata/` fixtures have run. Ask the user before `go run ./tools/plugins -manifest …` against a real repo.
- goja is pinned to `dc0ad5d0dc92` (2026-10-01): later commits need Go 1.26, and `go mod tidy` would bump `go.mod`'s Go version.
- Related: [[stream-ranking]], [[stream-requests]], [[stream-resolve]], [[tmdb-key]], [[kids-profiles]].
