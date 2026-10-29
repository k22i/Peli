---
name: collection-folders
description: "How Sinag's collection folder page (#96) works: /folder/$collectionId/$folderId, folderSources, the round-robin mergeSources depth rule, useFolderPages observers; read before a collection editor or per-source tabs"
metadata:
  type: project
---

The folder page (#96, ADR-0033) is `components/folder/folder-page.tsx` on `/folder/$collectionId/$folderId`. Home's collection tiles open it (`folderPath`/`folderParams`). The rules are in `lib/folder.ts`: `findFolder`, `folderSources` (`findCatalog` by manifest id, saved genre, skips gone/hidden/unaskable/repeat), `mergeSources`, `useFolderPages`.

**Why:** the user's ticket asks for one merged grid. Nuvio's "All" tab merges round-robin with de-duplication. Sinag only fills to the shallowest source that still has more, so pages append and nothing on screen moves.

**How to apply:**
- `useFolderPages` keeps one `InfiniteQueryObserver` per source over browse's `catalogPagesQuery`, so pages are shared with browse. Reuse it wherever a list of infinite queries is needed: `useInfiniteQuery` can't take a list.
- `FolderGrid`'s `loadMore` changes identity when the sources holding the grid back move (`wanted`). Otherwise `PosterGrid`'s end effect won't fire again after a page that only had duplicates.
- `Logo` is exported from `components/media/hero.tsx`.
- Stubbed WebKit check: copy `pw/` and `stubs/` from an old scratchpad and seed `Collections` in the store stub. Recreate `frontend/vite.stub.config.ts` with `mergeConfig(base, {server: {port: 9398}, resolve: {alias: [{find: /^@bindings\/(account|addons|appinfo|licences|secrets|store|syncer)$/, replacement: "<stubs>/$1.ts"}]}})`, then delete it. Row regions are labelled by heading, so in Playwright use `getByRole("region", {name})`, not `section[aria-label]`.
- Related: [[browse-pages]], [[home-page]], [[sync-module]], [[kids-profiles]].
