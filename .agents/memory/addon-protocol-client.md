---
name: addon-protocol-client
description: "How Peli's typed addon client (#37) is laid out and the addon quirks it found; read before #38, #42–#45, #50, #63"
metadata:
  type: project
---

The addon client (#37, ADR-0023) is `frontend/src/lib/addon-protocol/` (import from `@/lib/addon-protocol`): `types.ts`, lenient `parse.ts`, `routing.ts` (`serves`, `addonsFor`, `catalogsAccepting(addons, extras, type?)`, `findCatalog` for Home layout rows), `client.ts` (`addonClient`, `createAddonClient(transport)` for tests, `manifestUrl`, `resourceUrl`, `AddonError` kinds timeout/unreachable/status/invalid), `queries.ts` (`manifestQuery`, `catalogQuery`, `metaQuery`, `streamsQuery`, `subtitlesQuery`). Go fallback is `internal/addons` (`Fetch`, error codes only, never the URL).

**Why:** the epic left Go vs TS open; TS keeps 1,400-stream answers off the Wails bridge.

**How to apply:**
- Pass only enabled addons, and `Store.VisibleAddons` for browse/search ([[kids-profiles]]).
- Kitsu's "anime" catalogs list items typed `series`/`movie`: ask meta/streams by the item's type.
- Read `stream.description` only: the parser copies the deprecated `title` into it.
- AIOStreams' root `/manifest.json` is a web-app manifest with no CORS; its addon is at `/stremio/manifest.json` and has `configurationRequired`.
- Fixtures: `pnpm record:addons` (trimmed real answers; streams copied from the #6 spike corpus). Opt-in live test: `PELI_LIVE_ADDONS=1 pnpm exec vp test run src/lib/addon-protocol/live.test.ts`.
- Tests mock `@bindings/addons` with `vi.fn<() => void>()`; oxlint requires type parameters on every `vi.fn`.
