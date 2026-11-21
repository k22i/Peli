# Downloads part 9: Home row, connection pill, event mount and docs (#85)

Code, tests and docs only; nothing was run (no tests, typecheck, lint, fmt or build), per the rules — the coordinator runs all of that after merging.

## What changed

- **`routes/__root.tsx`**: `useDownloadEvents()` mounted once in `RootLayout`, beside `useSyncEvents` (and before `useConnectionEvents`), with a two-line comment saying it is the one place. Until now nothing in the app followed Go's download events; part 7's view and this row both rely on it.
- **`components/home/downloaded-row.tsx`** (new):
  - `finishedDownloads(downloads)` — the profile's `done` downloads, newest `doneAt` first, `homeRowLimit` (10) at most.
  - `DownloadedRow` — a `Row` of `PosterCard`s titled "Downloaded", with a "See all" link (`rowLinkClassName`, chevron) to `/library?view=downloads`. Each card carries the title's `menu` from `lib/title-actions`' `menuTitle` (read only, not edited), and `onClick` goes through `usePlay()` with the download's own `contentType`/`contentId`/`videoId`, so part 5's local-copy lookup runs. An episode's meta is `S1 · E2`; a film's card has none.
- **`routes/index.tsx`**: `HomeRows` reads `useDownloads(profileId)` and `useConnection()`. The row shows when at least one download is done: inside the `RowGroup` after "New episodes" online, and above the group (directly under the hero) when `useConnection()` is `Connection.Offline`. The "Titles you save and watch show up here." early return now also requires no finished downloads, so a device that holds only downloads isn't told Home is empty.
- **`components/shell/connection-status.tsx`**: the Offline detail is now "Showing what's saved on this device. Downloaded titles play; changes sync when you're back online." Unavailable is unchanged. No test asserted the old sentence (`grep` finds the string only in the component), so no test file was edited.
- **Docs**:
  - `docs/adr/0064-downloads-for-offline-viewing.md`: a "Built (2026-11-22)" section at the end — what each of the nine parts built (1–4 from `reports/downloads-*.md` on main; 5–8 from the specs, with a `TODO(coordinator)` for their final details) — plus a "Deviations parts 1 and 2 recorded" list (migration 5, recovery re-queueing `wifi`/`offline` waits, `unreachable`/`timeout` and 429/5xx backing off, the 60 s stall watchdog, `Config.Platform`, `.part` in `File`).
  - `README.md`: one line after the iOS paragraph — films and episodes download from a debrid or HTTP stream and play with no network, on macOS, iPhone and iPad, linked to ADR-0064.
  - `.agents/memory/downloads.md` (new) and its line in `.agents/memory/MEMORY.md`: the layout, the rules, the test gotchas found here and what is untested on a device.
- **`routes/downloads-home.test.tsx`** (new): the row shows the finished downloads newest first with "See all" and the episode meta; it hides while a download is still running; it sits below Continue watching online and above it offline; a card's play goes through `usePlay` (asserted by `Downloads.Playable` being asked for the video id before the picker opens); a `downloads:changed` event adds a title to the row with Home open, which is what proves the shell's single mount.

## Files touched

| File | |
|---|---|
| `frontend/src/routes/__root.tsx` | `useDownloadEvents()` and its import |
| `frontend/src/routes/index.tsx` | the row's data, order and offline placement; the empty-Home condition |
| `frontend/src/components/home/downloaded-row.tsx` | new: `finishedDownloads`, `DownloadedRow` |
| `frontend/src/components/shell/connection-status.tsx` | the Offline detail |
| `frontend/src/routes/downloads-home.test.tsx` | new: the row's tests |
| `docs/adr/0064-downloads-for-offline-viewing.md` | the Built section, the deviations list |
| `README.md` | the downloads line |
| `.agents/memory/downloads.md`, `.agents/memory/MEMORY.md` | the memory and its index line |
| `reports/downloads-home-docs.md` | this report |

Nothing outside those files. `lib/home.ts` needed nothing: Home's rows are built in `routes/index.tsx`, and `lib/home.ts` is the layout's row order (catalogs and collections), which the row doesn't join.

## Deviations from ADR-0064's interfaces

- **Poster cards, not landscape.** A download records `poster` only (the ADR's field), so a landscape row would crop a 2:3 image. The row uses `PosterCard`; to keep the layout's look, say so if a landscape row is wanted and the record should carry a backdrop instead.
- **The row is after "New episodes" online,** not first: Continue watching and New episodes are about what to watch next, and the downloads come before the catalog rows. Offline it is above both, as specified.
- **`finishedDownloads` lives in `components/home/downloaded-row.tsx`,** not in `lib/home.ts`: it is a presentation concern of this row, and `lib/home.ts` (the layout's order) isn't edited by this part.
- **The "See all" link depends on part 7.** It is `<Link to="/library" search={{ view: "downloads" }}>`, which typechecks once `k22i/downloads-view`'s `LibraryView` (`"upcoming" | "watchlist" | "downloads"`) is merged. On `main` alone, `LibrarySearch.view` has two values, so `pnpm typecheck` of this branch by itself would flag that line.
- **Also reading part 4's events hook:** `applyChanged` patches only lists already in the query cache, so the row follows an event only once a screen has asked for `List` — Home always does, which the test pins by waiting for Home's rows before emitting.
- **The memory is committed on this branch, not on `main`.** `AGENTS.md` asks for memory changes to go to `main` with their work; a dispatched worker may not touch `main`, so `.agents/memory/downloads.md` and its index line travel with this branch and land on `main` when the whole wave merges.

## Open questions

- If part 7 renames the search value (or the view's address), the "See all" link needs the same edit; it can't be verified until both branches merge.
- Offline, a download's `poster` URL may not load: the art isn't downloaded, so the card shows its title over the fallback. Saving poster art with the file would need a new field or a copy under `<root>/<id>/` — an ADR change, not taken here.
- The ADR's Built section describes parts 5–8 from their specs; the `TODO(coordinator)` there asks for their file lists and final deviations once they merge.
