# Downloads part 7: the Downloads view in Library (#85)

Not run (the task forbids it): the coordinator runs `pnpm typecheck`, `pnpm lint`, `pnpm fmt` and the
tests after merging. `@bindings/downloads` and `@bindings/store` are git-ignored and absent from this
worktree, so the imports are written against the appendix's generated shapes and part 4's
`lib/downloads.ts`.

## What changed

- **`components/library/downloads.tsx`** (new): the view.
  - `Downloads({ profile })`: one `useQuery(downloadsQuery(profile.id))` for the list (so a pending
    read shows skeletons rather than flashing the empty state), `useDownloadUsage()`,
    `useDownloadActions(profile.id)`. A failed read is a `LibraryNotice` with "Try again".
  - Two groups, `Downloading` (queued/downloading/waiting/paused/failed, in Go's creation order, which
    is the queue's) then `Downloaded` (by `doneAt`, newest first). `groupDownloads` does the split.
  - Rows follow Upcoming's: a `w-24` poster (`Artwork`, `use="poster"`, `showTitle`), the title, the
    episode's `S1 · E2 · Name` line, the stream's `resolution · size`, `statusText`, and — for
    downloading/paused/waiting — a progress bar with `"<bytes> of <total>"` (or just the bytes while
    the total is unknown) and the rate from `useDownloadRate(id)`.
  - Row actions: Pause (anything unfinished that isn't paused/failed), Resume (paused), Retry
    (failed, which is `Resume`), Cancel (unfinished) and Delete (done), plus "Go to title" on a
    finished row. The poster-and-text area is one button: it plays a finished download through
    `usePlay()` with `{type: contentType, id: contentId, title: name, videoId}` (so part 5's local
    copy plays first), and opens the title (`useOpenTitle`, on the record's season) until then.
  - Delete asks first when the download is finished: an `AlertDialog` titled
    `Delete <name>?` ("You’ll need a connection to download it again."). Cancelling an unfinished one
    doesn't ask.
  - Desktop multi-select: `lib/selection`'s `clickKind`/`toggleKey`/`selectRange`, Space and
    Delete/Backspace on a focused row, ⌘A/Esc on `window` (ignoring menus, dialogs and text fields),
    selection keys are the records' ids and are intersected with the list each render. Gated by
    `useFeature("multiSelect")`. The bar is `DownloadSelectionBar` — `material-pop`, `role="toolbar"`,
    `aria-label="Selection"`, "N selected · Delete · Done" — the same shape as the Titles view's.
  - iPhone (`useCompactShell`): Upcoming's compact rows (44×66 poster, three 13 pt lines), a menu
    (`ResponsiveMenu`, a sheet) with Pause/Resume/Retry, Go to title and Delete/Cancel download, and
    a swipe left on the row for Delete (lib/swipe-row, the search page's `RecentList` pattern).
  - The storage line at the foot of the list: `"<used> of <cap> used · <free> free"` from
    `useDownloadUsage()` (`formatBytes`), with a link to `/settings?section=downloads`.
  - Empty state: `LibraryNotice` with `Download`, "No downloads yet", "Download films and episodes
    from their page to watch them without a connection." Kids profiles get the same view and tab.
- **`lib/library.ts`**: the only shared-file change beyond the tab. `LibrarySearch.view` gained
  `"downloads"` (as a named `LibraryView` union) and `librarySearch` accepts it. `routes/library.tsx`
  needed no edit: its `validateSearch` *is* `librarySearch`, so the view value lives there.
- **`components/library/library-page.tsx`**: the `Downloads` tab in both switches (after Watchlist;
  the compact switch is now `grid-cols-4`, or 3 for kids), the `downloads` case in the
  `ViewSwitch` `onValueChange`, and the view branch in `Library` after the existing two, inside
  `LibraryFrame` (so `BrowseFrame` on desktop/iPad and `CompactLibraryFrame` on iPhone).
- **`routes/downloads-view.test.tsx`** (new), setup copied from `routes/library.test.tsx`
  (`@bindings/store`, `@bindings/secrets`, `@bindings/account`, `@bindings/syncer` mocked; the
  bindings' `@bindings/downloads` mock overridden per file, as `routes/tracking-ui.test.tsx` does
  for `@bindings/tracking`). Tests: the empty state (and that the tab is selected); the tab and the
  same empty state on a kids profile; rows and statuses from a mocked `List`, with the two groups,
  the episode's code line, the "Downloading 5 %" line, each size and the newest-first Downloaded
  order; Pause, Resume and Retry reaching the Service; Cancel deleting without a dialog; Delete on a
  finished download asking first and only then calling `Delete`; ⌘-click multi-select then Delete
  calling `Delete(profileId, [ids])`; the storage line and the Settings link's href; the compact
  iPhone frame, where the row menu deletes one (sheet → alert dialog → `Delete`).

## Files touched

- `frontend/src/components/library/downloads.tsx` (new)
- `frontend/src/routes/downloads-view.test.tsx` (new)
- `frontend/src/components/library/library-page.tsx` (the tab, the view case, the comments)
- `frontend/src/lib/library.ts` (the `view` union and its validateSearch — see the deviation below)
- `reports/downloads-view.md` (this file)

`components/library/compact-frame.tsx` was listed in the task but needs no change: the compact
switch is passed to it from `library-page.tsx` (`ViewSwitch`), which is where the tab went, and the
view has no sticky headers to offset.

## Deviations from ADR-0064's interfaces

- None in the interface: every query, hook, status helper, size formatter and action comes from
  `@/lib/downloads`, and `@bindings/downloads` is touched only through those. `useDownloadEvents()`
  is deliberately *not* mounted here — `lib/downloads.ts` says it belongs in the shell (part 9), and
  a second subscription would patch every list twice.
- **`lib/library.ts` is outside the "files you own" list**, but the `view` value cannot be added
  without it: `routes/library.tsx`'s `validateSearch` is `librarySearch` from there. It is three
  lines (one more union member, one more `===`), so the intent of "a view value only" holds.
- **The selection bar is a local `DownloadSelectionBar`, not `components/library/selection-bar.tsx`**:
  that component's props are the library's (Mark watched/unwatched/Remove from Library), and it is
  another part's file to edit. The new bar copies its markup, materials and `role="toolbar"`
  semantics; there is no `useBulkEdits` equivalent because downloads are deleted, not edited.
- **The multi-select asks when the selection includes a finished download** ("Delete N downloads?"),
  which item 6 asks for and item 3 didn't mention; a selection of unfinished ones deletes at once.
- **`AlertDialog` title uses `downloadLabel`** ("Breaking Bad · S1 E2"), so the dialog names the
  episode rather than just the show.
- **"Use Artwork's fallback"** is read as "go through `Artwork`", so a poster that fails offline
  shows its slate in the title's hue (with the title on it) instead of a broken image; a download
  record has no second image to fall back to.
- **The Settings link's `search` is cast to `PaneId`** (`"downloads" as unknown as PaneId`), because
  part 8 adds the pane to `components/settings/panes.ts`. The cast compiles before and after part 8.

  **This one line is the only thing that needs part 8 to be right:** the router builds a link's href
  through the target route's `validateSearch`, and `paneFromSearch` drops a section it doesn't know,
  so the storage line's href is `/settings?section=downloads` *once* part 8 registers the pane with
  that id. Until then it is `/settings`, and the assertion in `routes/downloads-view.test.tsx` ("the
  way to Settings", `toHaveAttribute("href", "/settings?section=downloads")`) fails. After part 8 the
  cast is redundant and can go.

## Open questions

- The multi-select rows are plain list items with a button each (`data-selected`), not the Titles
  view's `listbox`/`option` semantics: `PosterGrid` brings those and rows here aren't a grid. Worth
  adding `aria-multiselectable` semantics if the user moves between the two views a lot.
- Pause on a *queued* download is offered on the assumption that `internal/downloads` pauses a job
  that hasn't started (the ADR only spells out `Resume`). If it refuses, that button should be a
  no-op or hidden for `queued`.
- No toast confirms a delete or a pause here (unlike the library's removal Undo): the row leaves the
  list on `downloads:removed`. If the user wants Undo, it needs a record kept until the call returns
  — and files are gone, so it would be a re-download, not an undo.
- Nothing was checked in a real window (no tests, no build), and no live stream was resolved: the
  offline behaviour of `Playable` (part 5) is assumed, not observed.
- No `.agents/memory/` entry was written: five parts are landing at once and the memory index is
  shared, so the coordinator should make one (mine would be `downloads-view.md`: the view is
  `?view=downloads`, its two groups and row shape, the row actions, the selection bar, and the
  `?section=downloads` cast that part 8 removes).

## Fix round 1

The two failing tests in `routes/downloads-view.test.tsx` and the one lint item in
`components/library/downloads.tsx`. Still nothing run here (no tests, typecheck, lint or build): the
frontend's `@bindings/*` modules are not in this worktree, so the coordinator's rerun is the check.

- **The episode's line was split across elements** ("lists what is on its way…"):
  `getByText("S1 · E2 · Grilled")` cannot match `<span class="tnum">S1 · E2</span> · Grilled`, because
  the code sits in its own tabular span — Upcoming's row shape, which I kept. The test now reads the
  row's text instead (the `rowOf` helper, `toHaveTextContent`), the pattern `home.test.tsx`,
  `discover.test.tsx` and `library.test.tsx` already use for these lines, and asserts the stream of
  each row in the same way rather than `getAllByText("1080p · 1.4 GB")`. No markup changed, so no
  accessible name gained a leading-space problem.
- **The compact test was not a text problem — the page had thrown.** Its DOM was `ErrorScreen`
  (a `FocusScreen` with the sun ambient and the warning triangle, and no `AppShell` grain wrapper
  around it), which is the root route's error component. The cause: on iOS the shell mounts
  `useSeedAudioLanguages()` (`lib/device-languages.ts`), which calls `Store.SeedAudioLanguages(id,
  codes)` unguarded once the profile is in — and this test file's `@bindings/store` mock (copied from
  `library.test.tsx`, where iOS is off so the effect returns before the call) had no such method, so
  the effect threw `TypeError: Store.SeedAudioLanguages is not a function`. The DOM was captured after
  the throw, which is why `getByText` "couldn't find" a string that would otherwise have matched:
  `getNodeText` joins an element's own text nodes, as the passing storage-line assertion ("12 GB of
  50 GB used · 210 GB free") shows. Fixed by adding `SeedAudioLanguages: () => Promise.resolve(false)`
  to the store mock, as `ios.test.tsx`'s mock has it; the binding itself is real
  (`internal/store/service.go`), so nothing in the app needed guarding. The row assertion there also
  goes through `rowOf` and `toHaveTextContent` now.
- **The `PaneId` cast is gone** (lint, `no-unsafe-type-assertion`): part 8 registered the pane, so the
  `downloadsSection` constant and the `PaneId` import are deleted and `StorageLine` links with
  `search={{ section: "downloads" }}`, the literal typing the route's `validateSearch` expects (the
  same shape as `watchlist.tsx`'s `search={{ section: "tracking" }}`). The deviation and open items
  above that describe the cast and the pre-part-8 href no longer apply.

What is left: the coordinator's rerun. The two points the report raised before still stand — `Pause`
on a *queued* download assumes `internal/downloads` pauses a job that hasn't started, and no memory
entry was written for this part.
