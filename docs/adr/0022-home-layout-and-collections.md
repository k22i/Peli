---
status: accepted
date: 2026-10-27
---

# Home layout and collections: pulled from Nuvio's apps, kept as their blobs, pushed only to a custom server

Home's catalog rows follow the order the user set in Nuvio's apps, and the user's collections show on Home (#35, F7). The PRD forbids pushing either to Nuvio's backend. This ADR covers where the data comes from, how it is kept, and how the push is held to a custom server (ADR-0021).

## What Nuvio's apps keep

Read from the TV and mobile apps' sync code (to learn the format only; nothing was copied, since they're GPL-3), then checked with a read-only pull of the user's live account on 2026-10-27.

- **The layout** is `sync_pull_home_catalog_settings` with `p_platform = 'home_catalog_shared'`, the one platform the TV and mobile apps share. The spike's `desktop` had no rows, and neither did `tv`, `mobile` or `web`. Its `settings_json` is `{items: [{key, addon_id, type, catalog_id, enabled, order, custom_title, is_collection, collection_id}], hide_unreleased_content, …}`. A row is an addon catalog (`key` = `addon:type:catalog`) or a collection (`key` = `collection_<id>`). Live had 19 rows and one key Sinag doesn't read (`hide_catalog_underline`).
- **Collections** are `sync_pull_collections`' `collections_json`: `[{id, title, folders: [{id, title, sources: [{provider, addonId, type, catalogId, genre}], tileShape, coverImageUrl, titleLogoUrl, …}], pinToTop, viewMode, …}]`. Older folders have `catalogSources` with no provider. A genre of `"None"` means none. Live had 4 collections.
- Both name addons by their **manifest id**, not by the manifest URL that Sinag's addon list uses.

The server stores both as `jsonb` and never looks inside. A push replaces the whole blob.

## Pull: the whole blob, every pull

As with addons (ADR-0019), there is no feed. Each pull (ADR-0016) reads both, for the profile in use, and the cursor never moves. `store.SurfaceHomeLayout` and `SurfaceCollections` are new surfaces. A missing row is a delete. The store keeps **Nuvio's blob as it is** (canonical JSON, so the same blob from another app compares equal) and reads typed views out of it: `Store.HomeLayout` (`HomeLayout{Rows, HideUnreleased}`) and `Store.Collections`. An edit (`Store.SetHomeLayout`) changes only the fields Sinag knows and keeps the rest, row by row, so a push to a custom server doesn't drop what Nuvio's apps wrote. A push is the blob as it is here, with no three-way merge: Nuvio's own apps push the same way, and only custom servers are written to.

## The push guard, at three levels

1. **`nuvio.Client` refuses.** `PushHomeLayout` and `PushCollections` return `ErrNuviosServer` before any request, unless `OwnServer()`. That needs the client to point at a URL other than the one it was made with (Nuvio's, or `$SINAG_NUVIO_URL` in development) and at a host that isn't `nuvio.tv` or under it. `TestHomePushesRefuseNuviosServer` checks that no request is made. `TestNoLayoutOrCollectionCalls` now allows these calls in `home.go` only, where it used to forbid them in the whole package.
2. **`backend.Nuvio.Push` drops them unsent** (acked, with a warning) while on Nuvio's server, so a stray push can't be retried forever, and sends the rest of the batch.
3. **The edit is refused.** `Account.SetHomeLayout` returns `home_from_nuvio` for a profile linked to Nuvio's server. On a custom server, the edit is queued and pushed. A local-only profile (the Guest) keeps its own layout and queues nothing.

## On Nuvio's server, Home follows the layout read-only

A local edit on Nuvio's server would never reach the phone or TV, and the next pull would overwrite it. A local override that stops following the pull would make the desktop drift silently from the user's other devices. So on Nuvio's server, Sinag shows the layout as Nuvio's apps set it, and changes are made there.

## Home

`homeSections` in `lib/home.ts` gives the order: collections with `pinToTop` first, then the layout's rows that are turned on, then collections the layout doesn't name. A row for a collection that no longer exists is skipped. A collection shows as a row of its folders (poster or landscape tiles, from `tileShape`, with the cover image). Catalog rows are in the list but aren't drawn yet: they need the addon client (#37) and the catalog rows (#42), which should append catalogs the layout doesn't name in addon order, and match addons to layout rows by manifest id. Opening a folder is the browse page's (#43).

## Kids profiles see no collections

A kids scope (ADR-0014) is an allow-list of manifest URLs. Collections name addons by manifest id, so they can't be checked against it until manifests are read (#37). `Store.VisibleCollections`, which the frontend gets as `Store.Collections`, returns none for a kids profile. The layout only orders rows, so a kids profile still gets it; #42 filters catalog rows through `VisibleAddons` as before.

## What we give up

- **No merge on a custom server.** Two devices editing the layout at once: the last push wins, as in Nuvio's apps.
- **No collection editor.** `Store.SetCollections` and the push path exist and are tested, but nothing in the UI calls them. An editor must go through the account service with the same check as `SetHomeLayout`.
- **The shapes are the apps', not the server's.** Self-host can't check them. The contract tests (ADR-0020) check the row around the blob and that the push round-trips; the per-release check compares the blob on live by hand.

## Revisit if

Nuvio's apps move the layout to another platform name or change the blob, Nuvio allows third-party clients to write layouts, or the user asks to customise Home on Nuvio's server (then a local override, shown as such).

ADR-0017's "Never home layout or collections" expected #35 to need "its own surface and its own `Backend`". It has its own surfaces, but uses the same `backend.Nuvio`, with the guard above.
