# Downloads part 6: the entry points (#85)

Not run (the task forbids it): the coordinator runs `pnpm typecheck`, `pnpm lint`, `pnpm fmt` and the
tests after merging. `@bindings/downloads` and `@bindings/store` are git-ignored and not in this
worktree, so everything below is written against the appendix's generated shapes.

Branch `k22i/downloads-entry`, cut from `main` at `f582859` (the ADR, `18809fd`, is in its history).

## What changed

### `lib/download-pick.ts` (new) — choosing what to download

Everything the five entry points share, all of it built on `@/lib/downloads` (part 4) — no query,
status helper or action is re-implemented.

- `DownloadTarget` (`meta`, `video?`, `metaAddon`), `downloadTarget(meta, metaAddon, video?)`,
  `downloadVideoId(meta, video?)` (the picker's `streamId`: the video's id, else the film's own).
- `topDownloadable(view)`: the top pick, then each group in order, taking the first candidate whose
  own stream Go can fetch (`downloadable`, i.e. a link and not a magnet). A torrent-only pick is
  skipped, never downloaded (ADR-0064, the user's call at the gate).
- `downloadControl(download, finding)` → `{ label, action }`, the one place the wording lives:
  "Download" → "Finding a stream…" → `statusText(download)` ("Queued", "Downloading 42 %",
  "Paused", "Failed: …", "Downloaded"), with `action` = `download` / `resume` (`paused`, `failed`) /
  `remove` (`done`) / `none`.
- `downloadRows(state, label)` → the rows a menu shows (a `start` row with the caller's label, e.g.
  "Download next episode", or the record's `status` + `resume` + `remove`).
- `downloadState(downloads, meta, metaAddon, video)` and `pressDownload(state, downloads, remove?)`:
  the whole press mapping in one place, so the round action, the two sheets and the card menu agree.
- `useDownloadQueue(profileId)` → `{ download, downloadMany, stop, running, finding, runner }`.
  A queue of jobs; one invisible `DownloadRunner` per mounted host ranks the head job and leaves when
  it's added, so a season's episodes go one after another, never side by side. `stop()` empties it
  (what was added stays).
- `DownloadRunner` (invisible): asks `useStreamAddons` + `useStreams`, ranks with `useRankedStreams`
  and `rankingPrefs(…, remembered(chosen))` exactly as `usePreparedNext` does (`useEpisodeMap`,
  `useTmdbAliases`, `titleContext`, and `settleAfter` from `lib/pre-resolve`), takes
  `topDownloadable`, then hands the candidate to `DownloadAdder`. With nothing to download it toasts
  "No stream to download. Pick one in the stream list." and moves on.
- `DownloadAdder` (invisible): `useAddonSubtitles(profileId, subtitleTarget(...))`,
  `byLanguage(...)` → at most **two** in the profile's language → `subtitleRefs(...)` →
  `addRequestFor(...)` → `useDownloadActions().add(...)`. `autoSubtitle` isn't used (it applies the
  captions setting and the file's tracks; a download has no tracks yet).
- `useTitleDownloads(profileId)` / `useTitleDownloadsWith(profileId, queue)` → `TitleDownloads`
  (`profileId`, the profile's `list`, the `queue`, the `actions`).
- `useStreamDownloads(profileId, target, list)` → the picker's row path: no ranking, the row's own
  candidate goes through the same `DownloadAdder`; `has(candidate)` tells a row already downloaded
  (same video, same link).
- `downloadSeason(downloads, meta, metaAddon, airedEpisodes)`: queues the aired episodes with no
  record and not already queued, and toasts "Downloading N episodes" with a **Stop** action that
  calls `queue.stop()`.

### The entry points

- `components/title/title-page.tsx`: a Download round action (arrow-down) in the action row for a
  film, and for a series for the episode Play would play (hidden when there is none — `videoToDownload`
  in `lib/download-pick.ts`). It shows `downloadControl`'s label as its tooltip and accessible name,
  with a percent glyph while downloading, a check when done and the resume arrow for a paused or
  failed one. Pressing: download → queue; resume → `Resume`; a finished one opens a small
  `AlertDialog` ("Remove the download?") whose Remove calls `Delete`. The page hosts the queue and
  renders `queue.runner`; the same `TitleDownloads` goes to `<Episodes>`.
- `components/title/episodes.tsx`: beside "Mark season watched", a "Download season" button and,
  when the season has downloads, "Remove season downloads" (`Delete` with their ids). On the phone
  both are rows in the season's existing "•••" sheet. Passes an `EpisodeDownloads` down to the list.
- `components/title/episode-list.tsx`: the row's ⋯ menu and its right-click menu get
  "Download" (or "Finding a stream…" while it ranks), the record's status line, "Resume download"
  for a paused or failed one, and "Remove download". A row with a record shows a small badge on its
  still (`ArrowDownCircle` when downloaded, the percent while it runs, an arrow while it waits), and
  its play button's name gains ", downloaded" / ", downloading". Unaired rows get nothing.
- `components/title/title-more.tsx`: on the phone the Download lives in the "•••" sheet (the action
  row has no room for a fifth round action): "Download", the status, "Resume download" and
  "Remove download".
- `components/media/title-menu.tsx`: a card's menu gets "Download" for a film and "Download next
  episode" for a series (the Play target's episode), its status once it has a record, "Resume
  download" and "Remove download". The queue is hosted by the **card**, not by the popup, so the
  ranking outlives the menu that started it; the records and the actions are still read only while
  the menu is open (as the menu reads everything else).
- `components/streams/stream-list.tsx`: every row is wrapped in the row's own context menu
  ("Download this stream", or a disabled "Downloaded"), with a provider that mounts only on the
  picker (it derives the title and video from the route, and the addon from the title's cached
  details — no props from `streams-page.tsx`, which part 5 owns). Torrent rows, and rows on the
  player's switcher and the gallery, have no menu.

### Tests

- `src/lib/download-pick.test.ts` (new): `topDownloadable` through the real ranking engine (the
  linked pick taken; a torrent-only pick remembered on top skipped for the best linked one; nothing
  when every stream is a torrent), `downloadVideoId`, `videoToDownload`, `downloadControl`
  (every state and action), `downloadRows`, and `pressDownload` (queue / resume / ask-then-remove vs
  remove-at-once).
- `src/routes/downloads-entry.test.tsx` (new): the film's Download adds the linked candidate (with
  Peerflix's torrent remembered on top, so the torrent-only pick is provably skipped), the whole
  `AddRequest` checked; the all-torrent page toasts "No stream to download…" and adds nothing; a
  mocked `List` renders "Downloaded" and its confirm deletes the record; "Download season" queues
  S1E1, S1E3 and S1E4 (S1E2 already downloaded) in that order, one after another, with the
  "Downloading 3 episodes" toast; the picker's row menu adds that row's link.
- `src/routes/title-menu.test.tsx`: the card menu's expected items now include "Download" (its
  details aren't served in that test, so it is disabled).

## Deviations from ADR-0064's interfaces

- **None in the data:** every `AddRequest` is built by `addRequestFor`, every status by
  `statusOf`/`statusText`/`percent`, every delete by `useDownloadActions().remove` (which calls
  `Delete`), and the picker's rows use `downloadable` as the ADR says.
- **The picker's row menu is the row's context menu** (right-click, or press-and-hold on the phone)
  rather than a new "⋯" button per row. `streams.test.tsx` counts the rows' buttons (`shownStreams()`
  → `toHaveLength(5)`, `topPick()`), and a new button per row would have rewritten a dozen assertions
  in a shared file for a menu that the app's other rows already open this way (#134).
- **`lib/title-actions.ts` is untouched.** The card's download logic is in `lib/download-pick.ts`
  (it needs the queue, the records and the actions, which are downloads concerns), and
  `title-menu.tsx` imports it; nothing in `title-actions.ts` needed to change.
- **The phone's title page keeps the Download in "•••"** (`title-more.tsx`) instead of adding a fifth
  round action to a 402 pt row — the task named `title-more.tsx` for the iPhone.
- **Alternates are not considered.** `topDownloadable` skips a candidate whose own copy is a torrent
  even when one of its alternates has a link: `addRequestFor` sends `candidate.stream`, so taking an
  alternate would mean a new `AddRequestParts` field in part 4's interface. Reported as an open
  question rather than changed here.

## Open questions

- **Toasts during a season.** Each `add` toasts "Downloading <title> · S1 E3" (part 4's
  `useDownloadActions`), so a ten-episode season shows ten of those plus the season's own
  "Downloading 10 episodes". If that's too noisy, part 4 would need a quiet add (or a way to pass a
  toast flag) — it is not something this part can do without touching `lib/downloads.ts`.
- **A second press in the gap after an add** (between `Add` resolving and Go's record appearing in
  the list) would queue the same video again. It is harmless — Go's `Add` returns the existing record
  for a video whose download isn't `failed` (`service.go`, the "one per (profile, video)" loop) — so
  the queue only dedupes what it currently holds.
- **Subtitle gathering waits.** The Add waits a moment for the profile's subtitles to answer
  (`useAddonSubtitles.loading`), as the task asks; with a subtitle addon that hangs, Go gets the
  request when its 30 s query timeout ends, or at once when the profile has no subtitle language.
  Worth revisiting if it ever feels slow: the subtitles could be attached best-effort after the Add.
- **Part 5's picker.** `stream-list.tsx` reads the picker's title from the route
  (`pickerOf(pathname, search)`), so `streams-page.tsx` needed no change. If part 5 would rather pass
  its own `meta`/`addonUrl` down, the `RowDownload` context takes them without touching the rows.
- **Part 9** still has to mount `useDownloadEvents()` once in `routes/__root.tsx` (part 4's report):
  until then the lists refetch after an add, but nothing follows Go's events.
