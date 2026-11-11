---
name: library-housekeeping
description: "Remove from Continue Watching (Store.ClearContinueWatching = delete unfinished progress, why not a hide flag) and the Library's multi-select (lib/selection.ts, useBulkEdits, SelectionBar, listbox semantics, Space/⌘A/Esc)"
metadata:
  type: project
---

**Remove from Continue Watching.** `Store.ClearContinueWatching(profileID, contentID)` (bound as `Service.ClearContinueWatching`) deletes a title's unfinished progress entries in one transaction and queues a progress delete for each. It does not mark anything watched, and finished entries stay.

**Why a delete, not a hide flag:** Nuvio has no hidden state to sync; its apps remove from Continue Watching by deleting `watch_progress` rows. A local flag would not reach other devices and would need resetting on play. Deleting makes "comes back when played" free: playing saves fresh progress. All unfinished episodes go, not only the latest, because Continue Watching shows a show's latest unfinished entry and an older one would take its place. Pending pushes coalesce by key, so a delete replaces the queued upsert.

**How to apply (UI):** the shared title menu's "Remove from Continue Watching" ([[title-menus]]) calls `useTitleEdits().removeFromContinueWatching`: the row drops the title at once, a toast offers Undo (saves the entries back with `SaveProgress`). It appears on any card whose title has progress under 90 %, so Home's Continue Watching row has it, and so does every other card.

**Library multi-select** (`components/library/library-page.tsx` `LibraryGrid`, `selection-bar.tsx`, `lib/selection.ts`, `lib/library-bulk.ts`):
- ⌘/Ctrl-click toggles, Shift-click adds the range from the anchor (the last toggled), a plain click toggles once anything is selected (otherwise it opens the title). Space toggles the focused card, Shift+Space extends; ⌘/Ctrl+A selects all (not while a text field has focus), Esc clears, Delete removes the whole selection when the focused card is in it. The ⌘A/Esc listener is on `window` and ignores keys from menus and dialogs. The selection is a set of `type:id` keys; what a filter or sort hides drops out on render.
- `PosterGrid` takes `isSelected`: it then renders `role=listbox` + `aria-multiselectable` and each `li` `role=option` with `aria-selected`. Library tests therefore find the grid by role `listbox`. `PosterCard` takes `selected` (sun outline round the art + check; focus keeps its own ring) and `menuItems` (replaces the title menu's items; `TitleMenu` takes `items`).
- `SelectionBar`: a `material-pop` toolbar fixed at the foot ("N selected" · Mark watched · Mark unwatched · Remove from Library · Done). Right-clicking a card that is in a selection of 2+ shows the same actions for the whole selection; a card outside it keeps its own menu.
- `useBulkEdits(profileId)`: `setWatched({items, watched})` goes title by title through `useTitleEdits().setWatched` (a series needs its details for its episodes; one that can't be had is counted in an error toast; titles already in the asked state are skipped, so Undo reverses only what changed); `remove(items)` is optimistic like the single remove, with Undo.
- Tests: `routes/library-selection.test.tsx`, `lib/selection.test.ts`, Go `TestClearContinueWatching`, Continue Watching tests in `routes/title-menu.test.tsx`. Not checked in a real window; WebKit may fire Space's click on key-up despite `preventDefault`, which jsdom cannot show.
- Baseline: `store` Go tests `TestFixtures`, `TestSettingsPersistPerProfile`, `TestImportWatched` fail before this work; the frontend baseline is as in [[title-menus]].
- Related: [[library-page]], [[library-redesign]], [[progress-resume]], [[sync-module]].
