---
name: tmdb-key
description: "How Peli's optional TMDB key (#47) works: tmdb.api-key in the keychain, lib/tmdb.ts id mapping + useTmdbArt, Artwork fallback, test mocks; read before using TMDB anywhere else (#51, Home hero)"
metadata:
  type: project
---

The optional TMDB key (#47, ADR-0031) is the user's own, saved as `tmdb.api-key` in the keychain through the secrets service after a `/authentication` check. The webview holds it in the never-persisted `["secrets", "tmdb.api-key"]` query; TMDB answers live under `["tmdb", …]` (persisted) without the key in their keys.

**Why:** the ticket asks for the key in the keychain and for everything to work with no key; Nuvio's synced `tmdb_settings` blob is deliberately not used, so the key stays on the device.

**How to apply:**
- Use `useTmdbArt(tmdbRef(type, id, meta))`: mapping order is `moviedb_id`, `tmdb:<id>`, then IMDb id (`id` or `imdb_id`) via `/find`. It returns undefined with no key, so callers just fall back.
- TMDB sends CORS headers, so it's fetched from the webview (no Go fallback). Never log the URL: a v3 key is in `api_key`.
- `Artwork`/`Hero` take a `fallback`/`fallbackBackdrop` shown under new art while it loads — use it when swapping art.
- No TMDB key has been available for a live check; ask the user for one if a live test is needed. Never print it.
- Tests: route tests must mock `@bindings/secrets` (`Get`), or the Wails runtime's own call goes through the test's `fetch` stub — with `URL` objects, not strings.
- #99: the details request also asks `alternative_titles,translations` (title route tests' URLs name them); `TmdbArt.aliases` and `useTmdbAliases` feed the ranking ([[title-matching]]). Anything rendering `useStreamChoices` or `usePreparedNext` now reads the key, so mock `@bindings/secrets`.
- Related: [[title-page]], [[addon-protocol-client]].
