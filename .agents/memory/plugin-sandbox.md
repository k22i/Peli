---
name: plugin-sandbox
description: "How Nuvio JS plugins run (#56, ADR-0043): internal/plugins child process per call, host API, limits, StreamSource key/name/kind, tools/plugins, goja pin; read before #57, #58, #65 or touching the picker's sources"
metadata:
  type: project
---

Plugins (#56, ADR-0043) are `internal/plugins`. Each `getStreams` call is a fresh goja runtime in a **child process of Peli's own binary** (`PELI_PLUGIN_SANDBOX=1`; `main` calls `plugins.ServeChild()` first, and so does the package's `TestMain`). The host API is ours: `js/prelude.js` (fetch, Headers, timers, TextEncoder…, `require` allow-list), `js/cheerio.js` over `html.go` (x/net/html + cascadia), and `js/crypto-js.js` over `crypto.go`. Limits are in `DefaultLimits` (45 s, 256 MiB, 200 fetches). fetch refuses private and loopback addresses at dial time (`Limits.PrivateNetwork` is for tests only).

**Why:** the ticket asks for no file or process access and per-call time and memory limits. goja's interrupt can't stop a regexp or one huge allocation, so the process is what makes the limits hard. Nuvio's runtime is GPL, so the API was written from a survey of 489 community plugins.

**How to apply:**
- Frontend: `lib/plugins.ts` (`pluginStreamsQuery`, `toStream`, `pluginQuery` by TMDB id via `useTmdbId` in `lib/tmdb.ts`). `StreamSource` is now `{key, name, kind, …}` and `StreamSlice.source`, not `.addon`. `useStreamChoices` merges `usePluginSources` and returns `refresh`, which the picker and the player's switcher pass to `resolvePick`.
- #57 is built ([[plugin-management]]): `Installed()` is the stored, per-profile, off-by-default list; `PELI_DEV_PLUGINS` is gone (install the repository instead; `tools/plugins` has its own path). `Streams` only runs plugins `Installed` lists.
- Route tests that render the picker or the player must mock `@bindings/plugins` (`Installed`, `Streams` with `cancel`).
- The auto-mode classifier blocked running third-party plugin code (2026-11-04). Only our own `testdata/` fixtures have run. Ask the user before `go run ./tools/plugins -manifest …` against a real repo.
- goja is at `2cb8274eed06` (2026-10-14), which needs Go 1.26: `go.mod` says 1.26 and ci.yml's `GO_VERSION` is 1.27.x (the user's toolchain is 1.27). Bump both together.
- The classifier also blocked comments on tickets the user didn't name (#57), even after the user said to go ahead in chat: hand the command to the user to run with `!`.
- Related: [[stream-ranking]], [[stream-requests]], [[stream-resolve]], [[tmdb-key]], [[kids-profiles]].
