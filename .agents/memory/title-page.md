---
name: title-page
description: "How Sinag's title page (#45) is built: /title/$type/$id, titleMetaQuery fallback, Nuvio's watched rules in lib/title.ts, Store.SetWatched batch, useOpenTitle, Hero logo; read before #46, #48, #52, #60, #64"
metadata:
  type: project
---

The title page (#45, ADR-0029) is `components/title/` (`title-page.tsx`, virtualized `episode-list.tsx`) on `routes/title.$type.$id.tsx` (`?season=`). The rules are in `lib/title.ts`: `titleMetaQuery` (visible addons serving meta, in order, one at a time, no per-addon retry), `titleState` (marked, or progress ≥ 90 %; series watched = every aired episode of seasons 1+), `playChoice`, `episodeMarks`/`titleMark`, `seriesMarkChange`, `libraryItem`.

**Why:** the acceptance is "watched state and progress match Nuvio mobile". The rules are copied from NuvioMobile's `WatchingActions.kt`/`WatchedRepository.kt`: marking or unmarking clears progress, and the series-level mark follows the episodes. The user approved reconciling only after edits, not on view.

**How to apply:**
- Open a title with `useOpenTitle()(preview)`: it passes the card in `HistoryState.title`, so the hero paints at once.
- Watched edits go through `Store.SetWatched(profile, items, watched)`: one transaction, clears progress, skips items already marked. Then invalidate `watched`, `progress` and `continue-watching` for the profile.
- Queries: `titleWatchedQuery` `["watched", id, contentId]` and `titleProgressQuery` `["progress", id, contentId]`, under the sync prefixes.
- `useLoadedAddons(profileId)` (`lib/home.ts`) gives visible addons plus manifests without the catalog visibility check. `useBrowsableAddons` builds on it.
- `Hero` takes `logo`. `scrollParent` is exported from `poster-grid.tsx` for page-scrolled virtual lists.
- Tests: `routes/title.test.tsx` keeps an in-memory `db` behind the store mock, so marks and the library behave like Go's. `writes()` reads SetWatched calls as `+1x2` / `-show`.
- Stubbed WebKit check: the #44 harness plus a store stub with `TitleWatched`/`TitleProgress`/`SetWatched` in memory. Match search cards exactly (`/^Breaking Bad\s*2008/`): Cinemeta also lists the minisodes.
- Related: [[search-page]], [[browse-pages]], [[home-page]], [[kids-profiles]], [[addon-protocol-client]].
