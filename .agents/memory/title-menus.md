---
name: title-menus
description: "Context menus for titles (cards) and episodes: TitleMenu + lib/title-actions.ts, the `menu` prop on cards, TitleMenuExtras slot for later groups, keyboard opening, episode menu, startOver, test gotchas"
metadata:
  type: project
---

Every poster/landscape card can open one shared right-click menu (a bottom sheet on the iPhone since #134, see [[bottom-sheets]]). `components/media/title-menu.tsx` is `TitleMenu` (`ResponsiveContextMenu`, popup `material-pop w-60`) and `openOnContextKey`; `lib/title-actions.ts` is the logic: `MenuTitle` (a `TitlePreview` plus `imdbId`), `menuTitle(meta)`, `libraryMenuTitle(item)`, `imdbIdOf`, and `useTitleEdits(profileId)` (`setWatched`, `saveToLibrary`, `removeFromLibrary`, `clearProgress` mutations). The title page uses the same hook, so marks and library edits go through one path.

A card opts in with `menu={menuTitle(meta)}` (or `libraryMenuTitle(item)`, or a literal for Continue Watching). Wired: Home (catalog, library, Continue Watching rows), Browse, Search, Folder, Library, Upcoming rows. Collection folder tiles and the gallery have no title, so no menu.

**Why:** one set of actions wherever a title shows, with keyboard access. The items read their data only when the menu opens (details through `titleMetaQuery` + `cachedTitleMeta`, watched, progress, library), so a screen of cards costs nothing.

**How to apply:**
- Items: Play/Resume (`playChoice`, falls back to `usePlay` with the bare title, which opens a series' page), Choose a stream… (navigates to `streamsPath` with the choice's target), Go to title, Add to/Remove from Library (add waits for the details, since `libraryItem` needs meta + addon URL), Mark watched/unwatched (a series needs its episodes; same rules as the title page via `titleMark`/`episodeMarks`/`seriesMarkChange`), Remove from Continue Watching (shown when the title has progress under 90 %; takes those entries out with `Store.RemoveProgress`), Copy IMDb link (only with a `tt` id).
- **Extension point:** `components/media/title-menu-extras.tsx` exports `TitleMenuExtras({ title, meta, profile })`, rendered last inside the popup and mounted only while open. A Tracking group goes there (own `ContextMenuSeparator` first). `profile.kids` is the guard: kids profiles get nothing that writes to tracking. The built-in items are library/watched writes, which kids may do.
- Keyboard: the card's `onKeyDown` calls `openOnContextKey` (context-menu key, Shift+F10), which dispatches a synthetic `contextmenu` at the element's centre, since browsers send none for Shift+F10 on a Mac. The popup's `finalFocus` returns focus to the card (`[data-row-item]`/`button` inside the trigger). The trigger is a `contents` wrapper, so it can't take focus itself.
- Library writes are optimistic (`setQueryData` on `["library", id]`, rolled back on error); a removal toasts with Undo (the saved item comes from the cache snapshot). Watched/progress edits invalidate the `watched`, `progress`, `continue-watching`, `last-watched` prefixes and refetch the title's own two keys with `refetchType: "all"`, because their observers are gone once the menu closes.
- Episode rows (`components/title/episode-list.tsx`, `EpisodeMenu` prop built in `episodes.tsx`): Play/Resume, Play from start (when in progress), Mark (un)watched, Mark all up to here watched/unwatched (main episodes up to and including this one; not on specials), Mark season (un)watched, Clear progress. The ⋯ menu stays as it was. Unaired rows have no menu.
- `PlayTarget.startOver` makes the picker start at 0 whatever progress is stored (`streams-page.tsx`); the picker otherwise resumes from the store.
- Tests: `routes/title-menu.test.tsx` (Home, Search, Library, keyboard; in-memory store mock) and three episode-menu tests in `routes/title.test.tsx`. user-event installs its own clipboard, so read it back with `navigator.clipboard.readText()` instead of stubbing `writeText`. After "Mark season watched" on a series expect a second write, the series-level `+show`.
- Baseline: at the commit this was built on, `pnpm test` already has ~75 failures (player, settings, plugins, browse/search timing, `url.includes` in title tests) and `vp check` has 10 `ProfileSettings` type errors in test fixtures; none come from this work. Run files one at a time (`--no-file-parallelism`): the shell-nav waits time out under load.
- Not checked in a real window (jsdom only).
- Related: [[title-page]], [[library-page]], [[sync-module]], [[kids-profiles]], [[stream-picker]], [[tracking-integrations]].
