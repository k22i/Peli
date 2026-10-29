---
name: library-page
description: "How Sinag's Library page (#46) is built: lib/library.ts rules, Store.LastWatched + [\"last-watched\", id] key, context-menu/Delete removal with Undo, test and WebKit-harness gotchas; read before #48, #96"
metadata:
  type: project
---

The Library page (#46, ADR-0030) is `components/library/library-page.tsx` on `/library` (`?type=&sort=`, defaults left out). The rules are in `lib/library.ts`: `libraryItems` (filter + sort), `libraryTypes` (Movies, Shows, Anime, then others), `librarySearch`, `libraryPreview` (moved from Home), `lastWatchedQuery`.

**Why:** the user approved a Go `Store.LastWatched` over building "recently watched" from `Watched` + `ContinueWatching`, because Continue Watching drops finished entries. They also approved removal through a context menu plus Delete, since a card is already a `<button>`.

**How to apply:**
- `["last-watched", id]` is its own top-level key, listed under both the progress and watched surfaces in `surfaceQueryKeys`. Don't put it under `["watched"]`: `sync.test.tsx` checks that a progress pull leaves watched queries alone. Any watched/progress edit should also invalidate `last-watched` (the title page does).
- The coss `context-menu` is in `components/ui`. Wrap a card in `<ContextMenuTrigger className="contents">`; tests open it with `fireEvent.contextMenu(card)`.
- Base UI gives a Toggle with `value=""` a generated ID, so the All chip uses the value `"all"`.
- Don't swap the toolbar for a skeleton while a secondary query loads: it unmounts an open Select. Tests then can't find options.
- Tests: a card without art prints its name twice (once on the artwork), so read the caption with `card.lastElementChild.firstElementChild`.
- Stubbed WebKit: the router uses hash history in the dev build, so links are `/#/library`. The stub's `LastWatched` must take the max per title.
- Related: [[title-page]], [[browse-pages]], [[home-page]], [[virtualized-rows]], [[sync-module]].
