---
status: accepted
date: 2026-10-29
---

# The addon protocol client: TypeScript in the webview, lenient parsing, Go only as a fetch fallback

Every Discover, Streams and Player feature asks addons for something: Home and browse ask for catalogs, the title page for a meta, the stream picker for streams, the player for subtitles. #37 builds the one client they all use, in `frontend/src/lib/addon-protocol/`. The epic (#36) left open whether it would be Go or TypeScript. This ADR records that choice, how answers are read, which addons get asked, and how requests are timed out, cancelled and cached.

## TypeScript, with Go only fetching

The client is TypeScript and runs in the webview. Its answers go straight to TanStack Query, the ranking engine (#51, also TypeScript, in a Web Worker) and the UI, so they never cross the Wails bridge. Comet alone sends about 1,400 streams for a popular title (#6). A Go client would encode each answer to JSON, pass it across the bridge and decode it again, and the types would have to be kept in step in two languages.

Most public addons send `Access-Control-Allow-Origin: *`, since Stremio's web app needs it. Some don't. AIOStreams' root page sends no CORS headers, and neither do some error pages, so the webview can't read them. `internal/addons` has one bound method, `Fetch(ctx, url)`, which does a GET and returns the status and body. The client calls it only after the webview's fetch fails with a `TypeError`, which is how a CORS failure shows. After that it sends every request for that origin through Go for the rest of the session. Cancelling the call in the frontend cancels Go's context. Go caps a fetch at 2 minutes and 32 MB, and refuses anything but http and https. Its errors are codes (`timeout`, `unreachable`, `too_large`, `invalid_url`) and never contain the URL, because a URL's config segment can hold a debrid key. Wails logs call arguments at debug level only, and release builds discard its log.

## Lenient parsing that keeps unknown fields

Addons are written by many people and nobody checks them. `parse.ts` follows these rules:

- **Only a missing core refuses the answer.** That means a manifest without `id`, `name` and `version`, or an answer without its `metas`, `meta`, `streams` or `subtitles`. The error is `AddonError` of kind `invalid`.
- **Bad fields are dropped, bad items skipped.** A field of the wrong type is dropped; numbers are read from numeric strings, and a lone string counts as a list of one. A list item without its own core is skipped: a meta needs an `id` and a `type`, and a subtitle needs a `url` and a `lang`.
- **Unknown fields are kept.** Every type has `[field: string]: unknown`. Peerflix's top-level `seed`, `sizebytes`, `quality` and `language` reach the ranking engine.
- **Known quirks are normalised once.** A stream's deprecated `title` is copied to `description`, since Torrentio and TorrentsDB send only `title`; `title` is kept as well. Cinemeta's episode `name` becomes `title`, and its `description` becomes `overview`. Legacy `extraSupported`, `extraRequired` and `genres` become `extra`. A short-form resource (`"stream"`) gets the manifest's types and id prefixes.

The client never throws a schema error for something it can do without.

## Routing follows Stremio's rules, in the user's order

`routing.ts` decides which addons get asked:

- **Meta, streams and subtitles.** `serves(manifest, resource, type, id)` checks whether the addon lists the resource, the resource (or manifest) lists the type, and the id starts with one of the resource's (or manifest's) id prefixes. No prefixes means any id. An addon with `configurationRequired` answers nothing.
- **Catalogs.** `catalogsAccepting(addons, extras, type?)` returns the catalogs that can be asked with exactly those extras: everything the catalog requires is given, and it supports everything given. With no extras it gives Home's and browse's catalogs, `["search"]` gives search's, and `["genre"]` gives the ones a genre filter can narrow.

Results stay in the order given, which is the user's addon order. Callers pass only enabled addons, and for browse and search only `Store.VisibleAddons` (ADR-0014).

A catalog's items carry their own type. Kitsu's "anime" catalogs list `series` and `movie` items, so meta and stream requests must use the item's type, not the catalog's.

## Timeouts, cancellation and caching

- **Timeouts per resource.** Manifest 15 s, catalog 20 s, meta 15 s, subtitles 15 s, and streams 30 s, because Comet took up to 18 s and a slow addon's streams are still worth showing (#50). A caller can pass its own timeout.
- **Cancellation.** Each request also follows the caller's `AbortSignal`, which is TanStack Query's signal in `queries.ts`. Leaving a screen cancels its requests, including any that went through Go.
- **Caching.** Manifests, catalogs and metas use `meta.persist`, so Home can choose and draw its rows from cache within its 2 s budget (#42). They stay fresh for the addon's `cacheMaxAge`, kept between 1 minute and 1 day, or 1 hour if it sends none.
- **Streams are never persisted.** A debrid link embeds the user's key and expires. Streams are fresh for 5 minutes and aren't retried, so a slow addon's error shows instead of doubling its wait. Subtitles aren't persisted either.

## What we give up

- **One wasted request per CORS-less origin per session.** The webview's attempt fails before Go is asked. That happens once per origin, then Go is used directly.
- **Error pages without CORS headers send that origin through Go.** An addon whose normal answers do carry CORS headers then loses nothing but the webview's own HTTP cache.
- **Lenient parsing hides some broken addons.** A broken field is dropped silently. The manager (#38) shows load errors for whole answers only.
- **Fixtures are a snapshot.** They are real answers trimmed to a few items each, so they don't cover every addon or every shape. `pnpm run record:addons` re-records them, and `SINAG_LIVE_ADDONS=1` runs one opt-in test against the live addons.

## Revisit if

Wails gets a cheap way to stream large data across the bridge; most popular addons stop sending CORS headers; or the protocol adds resources or stream kinds that need parsing beyond keeping their fields.
