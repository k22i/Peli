---
status: accepted
date: 2026-11-04
---

# Nuvio plugins: one goja runtime per call in a child process, a host API written from how plugins behave, streams ranked with the addons'

#56 (F18) runs Nuvio's JS plugins, its "local scrapers": community JavaScript that scrapes streaming sites and answers stream links. Nuvio runs them in Hermes inside its React Native app. Peli runs them in [goja](https://github.com/dop251/goja), a JavaScript engine in pure Go, sandboxed so a plugin can't touch the user's files, processes or network beyond what the host gives it. Plugin management (install, enable, sync, off by default) is #57. Until then there's no list of plugins, and nothing runs unless a dev build names a manifest.

## What plugins expect

The host API was worked out by reading what plugins call, not from Nuvio's code (GPL-3.0, so its runtime isn't copied). I surveyed 489 plugins in five public repositories (yoruix/nuvio-providers, Gowaru, NiakVIO, Nuvio-Providers-Latino, mkv9903) on 2026-11-04:

- **Shape**: one CommonJS file, often an esbuild IIFE bundle (`var __provider = (() => {…})()`), that sets `module.exports = { getStreams }` and often `globalThis.getStreams` as well. `getStreams(tmdbId, mediaType, season, episode)` takes a TMDB id as a string, `"movie"` or `"tv"`, and numbers for an episode (null for a film). It returns a promise of `{name, title, url, quality, size, headers}`. Bundles turn async functions into generators (`__async`) for Hermes, so both async/await and generators must work.
- **Manifests** are a bare list of scrapers or `{name, version, scrapers: [...]}`. Each scraper has `id`, `name`, `filename` (relative to the manifest), `supportedTypes` (`movie`, `tv`, sometimes `anime`), `enabled`, `disabledPlatforms` and more.
- **Modules** they `require`: `cheerio-without-node-native` (HTML) and `crypto-js` (mostly `AES.decrypt` with `CipherParams`, CBC, Pkcs7, `enc.Hex`/`Base64`/`Utf8`). Some bundles probe `require("util")` and other Node modules inside a `try`, and do without them.
- **Globals**: `fetch` (in nearly all of them, with `headers`, `method`, `body`, `redirect`, `signal`; responses read with `.text()`, `.json()`, `.headers.get`, `.ok`, `.status`, `.url`), `URL`, `URLSearchParams`, `atob`, `setTimeout`, `AbortController`, `TextEncoder`/`TextDecoder`, `Promise.allSettled`, `eval` (to unpack `p,a,c,k,e,d` players), `SCRAPER_SETTINGS`. `crypto.subtle`, `Buffer`, `process` and `XMLHttpRequest` are only feature-tested, mostly by polyfills bundled in.

## The sandbox

| File | |
|---|---|
| `internal/plugins/sandbox.go` | `run(ctx, Job)`: a fresh runtime, the host API, the plugin loaded as CommonJS, its promise awaited and its answer cleaned |
| `internal/plugins/loop.go` | The event loop: timers, and host work posted back to the runtime's goroutine |
| `internal/plugins/fetch.go` | `fetch`: the only way out of the sandbox |
| `internal/plugins/html.go`, `js/cheerio.js` | HTML parsing and CSS selectors in Go (x/net/html, cascadia); the jQuery-like API in JS |
| `internal/plugins/crypto.go`, `js/crypto-js.js` | Hashes, HMAC, PBKDF2, EvpKDF, AES/DES/TripleDES in Go; crypto-js's API in JS |
| `internal/plugins/js/prelude.js` | The globals: fetch, Headers, Response, Request, FormData, AbortController, timers, TextEncoder/Decoder, atob/btoa, crypto.getRandomValues, console, `process.env`, `require` |
| `internal/plugins/child.go`, `runner.go` | The child process and the parent that starts, feeds and kills it |
| `internal/plugins/service.go`, `manifest.go` | The Wails service (`Streams`, `Installed`), the code download and cache, manifests |
| `tools/plugins` | Runs a manifest's plugins, or one file, and reports what each answered |

**No file or process access, by construction.** goja has no I/O of its own: a script sees only what the host puts in its runtime. Peli puts in the API above and nothing else. `require` knows four names (`cheerio-without-node-native` and its aliases `cheerio` and `react-native-cheerio`, `crypto-js` and `crypto-js/*`, Node's `buffer` and `url` from goja_nodejs, which are pure Go and do no I/O). Anything else, `fs` and `child_process` included, throws `MODULE_NOT_FOUND`. `process` is React Native's: `{ env: { NODE_ENV: "production" } }`. Plugins that check for `crypto.subtle` find none and use crypto-js.

**One runtime per call, in its own process.** Each `getStreams` call runs in a child process: Peli's own binary, started with `PELI_PLUGIN_SANDBOX=1`. `main` calls `plugins.ServeChild()` before anything else, so the app never starts there. The child reads one job (code, query, settings, limits) on stdin, writes one answer on stdout and exits. It gets an empty environment except what TLS needs on Linux and Windows, and its working directory is the temp folder. A plugin can't keep state between calls, see another plugin, or crash or bloat the app. goja's interrupt only works between JS instructions, so the process is also what makes the limits hard: a regexp backtracking inside goja, or one huge allocation, ends that child and nothing else. Four children run at once at most. Starting one takes about 70 ms on an M1 Pro.

**Limits**, per call (`DefaultLimits`):

| | |
|---|---|
| Time | 45 s for the whole call. The child interrupts the plugin at 45 s, and the parent kills the child 2 s later. Addons get 30 s (#50), but a plugin scrapes a search page, a title page and an embed host in turn. Leaving the picker cancels the call, which kills the child. |
| Memory | 256 MiB of heap. `debug.SetMemoryLimit` makes the GC work harder near it. A watchdog reads the heap every 10 ms and interrupts the plugin once it goes over, and exits the child if that hasn't ended the call within a second. |
| Requests | 200 fetches, 8 at once, 30 s each, bodies up to 16 MiB |
| Recursion | 4,000 calls deep, then a `StackOverflowError` |
| Answer | 500 streams, URLs up to 8 KiB, text fields cut to 500 characters, 32 headers |

**Network only through `fetch`.** goja can't open a socket. The host's `fetch` refuses loopback, private, link-local, CGNAT, multicast and the other special ranges at dial time, after DNS, so a hostname can't point a plugin at the user's router or LAN, or at Peli's own loopback servers (the torrent link, ADR-0040). It uses no proxy, since a proxy on loopback would get round that check. Only http and https are allowed. Each call has its own cookie jar, kept for that call only, since some plugins log in or pick up a session cookie and then ask for pages. `redirect: "manual"` answers the 3xx with its `Location` header, as Node's fetch does. A request without a `User-Agent` sends Peli's.

**The answer is untrusted.** It's read with the `JSON.stringify` saved before the plugin ran, so a plugin can't replace it. Then each stream is checked: only http and https URLs, de-duplicated, text fields trimmed, headers kept only if they're valid names and values (no CR or LF), a numeric size written as "1.5 GB". `{streams: [...]}` is also accepted, and nothing (`undefined`) counts as no streams. Errors reach the frontend as codes only (`timeout`, `memory`, `failed`, `bad_answer`, `stalled`, `crashed`, `invalid_plugin`, `unreachable`), since a plugin's message can quote the pages it scraped. Plugin `console` output goes nowhere unless `PELI_PLUGIN_LOG=1`.

**The HTML and crypto APIs are ours.** Bundling cheerio means bundling its parser and Node shims, and bundling crypto-js means vendoring a library outside the notices tool's Go and npm scans. Both APIs are small in practice. So Go does the work (x/net/html, cascadia selectors with `:contains` and `:has`, Go's crypto) and about 900 lines of our own JS give it cheerio's and crypto-js's shapes. Elements look like htmlparser2's (`type`, `name`, `attribs`, `data`, `parent`, `children`, `next`, `prev`), so plugins that walk nodes by hand work. crypto-js's decrypt is just as lenient: a wrong key gives garbage or "Malformed UTF-8 data", never a cipher error. Its PBKDF2 defaults are 4.2's (SHA-256, 250,000 iterations). Not covered: cheerio's DOM writes beyond `attr` and `remove`, crypto-js's RC4, Rabbit and RIPEMD-160, and crypto-js's Keccak SHA3 (ours is FIPS 202).

**goja** is at its 2026-10-14 commit (`2cb8274eed06`), which needs Go 1.26, so `go.mod` asks for Go 1.26 and CI builds with 1.27, as the dev machines do.

## Plugin streams in the picker

`frontend/src/lib/plugins.ts` asks each installed plugin that serves the title, through `Plugins.Streams`. It's one TanStack query per plugin, like an addon's streams query (#50): not retried, not persisted, kept 5 minutes, and cancelled when the picker is left. The answer becomes ordinary `Stream` objects. `name` is the site and its quality line, `description` the title and a `💾 2.1 GB` line (which the ranking parser reads), with `behaviorHints.videoSize`, `proxyHeaders.request` from the plugin's headers, and `notWebReady`. `StreamSource` is now any source (`key`, `name`, `kind`), so `useStreamChoices` feeds addon and plugin answers into the same `RankingSession` (ADR-0035) under keys like `plugin:<id>`. Plugin streams are ranked, de-duplicated against addon copies, resolved (ADR-0037, with the plugin's headers) and switched to in the player (#68) like any other. A link that expires is asked for again from its plugin.

**By TMDB id.** Plugins take TMDB ids and Peli's titles mostly have IMDb ids. The id comes from Cinemeta's `moviedb_id`, from a `tmdb:` id, or from the user's own TMDB key (ADR-0031) through `/find`. A title with none of these (an unmapped Kitsu anime, or an IMDb id with no key and no `moviedb_id`) doesn't ask plugins. The episode's season and number come from the video id. Plugins aren't asked until the title's details have loaded, so an IMDb-only title first lists its addons' streams and the plugins join a moment later.

**The list** (replaced by [ADR-0047](0047-plugin-management.md): a stored per-profile list, `PELI_DEV_PLUGINS` removed). `Plugins.Installed` is empty until #57 keeps a list, so nothing runs for users yet and plugins stay off by default as the requirement asks. In a dev build, `PELI_DEV_PLUGINS=<manifest URL>` lists that manifest's enabled plugins (not ones with `desktop` in `disabledPlatforms`). The picker's summary says "sources" instead of "addons" when a plugin is among them.

## Not done here

- **The plugin list, enable switch, warning and sync** are #57. Nuvio keeps plugins per profile in a `plugins` table (PostgREST read, `sync_push_plugins` write, `uses_primary_plugins` sharing; docs/spikes/nuvio-backend.md). `SCRAPER_SETTINGS` per plugin goes with it.
- **Next-episode auto-pick** (#65) and remembered sources (#58) still rank addon streams only.
- **An OS sandbox around the child** (macOS `sandbox_init`, seccomp, a Windows job object) would add a second wall if goja or a host function had a hole. It isn't needed for what plugins can reach today. Revisit if the host API grows file or process features.
- **A live run against the surveyed repositories** wasn't part of the build. The sandbox ran our own fixture plugins, which copy their bundle shapes. `go run ./tools/plugins -manifest <url>` runs a whole repository.
