# Downloads tray follow-up, part C: honest download states in the stream row menu

Nothing was run (the task forbids it): no tests, typecheck, lint, formatter, build, pnpm, node or Go.
The coordinator runs all of that after merging. `@bindings/*` are git-ignored and absent from this
worktree, so the code below is written against the record shape in the task's appendix.

Branch `k22i/tray-menu`, cut from `main` at `0cc1050` ("shared open flag for the downloads tray"),
which is also `HEAD` — so the branch already contained the commit it had to.

## The bug

`useStreamDownloads` exposed `has(candidate)`: true for **any** record with that video and URL,
whatever its state. `RowMenu` read that as "downloaded", so a stream whose `Add` had only just been
queued claimed **Downloaded** with a check.

## What changed

### `frontend/src/lib/download-pick.ts`

- `has` is gone. `StreamDownloads` is now
  `{ profileId, downloadOf(candidate), save(candidate), saving, pending(candidate), runner }`:
  - `downloadOf(candidate)` returns the matching **record** (same video, same link), whatever state
    it is in — the caller decides what that means from `statusOf`.
  - `pending(candidate)` is true while that candidate's own `Add` is out (the `picked` state, matched
    by candidate key), which is what the menu's "Starting download…" shows.
  - `profileId` rides along so a menu can build `useDownloadActions(profileId)` for pause / resume /
    cancel / remove without a second context.
- Two pure helpers do the work and are exported for the unit tests: `downloadOf(list, videoId,
  candidate)` (newest record with that video and link — Go keeps one per video unless one failed and
  was added again, and a title can hold two sources of the same episode) and `pendingOf(picked,
  candidate)`.
- Nothing else in the file changed: the queue, the runner, the adder, the season flow are as they
  were.

### `frontend/src/components/streams/stream-list.tsx`

- **`RowMenu`** no longer says "Downloaded" for a record. Its items are a new `RowDownloadItems`
  component, so the hooks it needs (`usePlay`, `useNavigate`, `useDownloadActions`) run only while a
  menu is open, not once per visible row:
  - no record: "Download this stream" (Download icon); while that candidate's Add is out, a disabled
    "Starting download…" with `Spinner`.
  - `queued` / `waiting`: a disabled status line (`statusText` → "Queued" / "Waiting for Wi-Fi"),
    `ResponsiveMenuSeparator`, then "Show downloads" (`openDownloadTray()`), "Pause download",
    "Cancel download" (destructive).
  - `downloading`: a disabled "Downloading · 40 %", then the same three.
  - `paused`: a disabled "Paused · 40 %", then "Resume download", "Show downloads", "Cancel
    download".
  - `failed`: a disabled "Download failed: <reasonText>", then "Retry download" (= resume), "Cancel
    download".
  - `done`: a disabled "Downloaded" with the check, then "Play downloaded copy" (`usePlay` with the
    record's own target `{ type, id: contentId, title: name, videoId }` — the local copy wins, since
    `usePlay` asks `Downloads.Playable` first), "Show in Library" (`/library?view=downloads`) and
    "Remove download" (destructive).
  - Every item is a plain `ResponsiveMenuItem`, so the phone's bottom sheet keeps working unchanged.
- **Remove download confirms** through the title page's alert-dialog pattern (a
  `RemoveDownloadDialog` in `RowMenu`, the state living outside the popup because the menu closes
  when an item is chosen). It is rendered only while it is asked — a closed dialog per visible row
  would be five mutation observers each. "Cancel download" removes a partial record at once, with no
  confirm, as the title page's action already does (a partial download has nothing finished to lose).
- **A row's own mark**: `StreamDownload` is a fixed `size-4` slot after the badges (after the warning
  on the phone) in all four row layouts, holding a check-circle once `statusOf` is `done` and an
  arrow inside a tiny progress ring otherwise (`percent` as the ring's dash offset). Both carry
  `role="img"` and `statusText` as their `aria-label` ("Downloading 40 %", "Queued", "Downloaded").
  Rows without a record draw the empty slot, so a row's badges don't shift when its download arrives.
  The slot is only in the picker (the `RowDownload` context is null in the player's switcher and the
  gallery).
- Imports added: `AlertDialog*`, `Button`, `ResponsiveMenuSeparator`, `Spinner`, `useNavigate`,
  `usePlay`, `openDownloadTray`, `downloadLabel`, `percent`, `reasonText`, `statusOf`, `statusText`,
  `useDownloadActions`, the store's `Download` (aliased `DownloadRecord`, since lucide already has a
  `Download` icon) and the icons ArrowDown, ArrowDownCircle, CheckCircle2, Library, Pause, RotateCcw,
  Trash2, X.

### `frontend/src/lib/downloads.ts` (allowed after the coordinator's answer — this toast only)

The shared `useDownloadActions().add` success toast already fired for **every** way into a download,
and its promise resolves either way (`settledPromise` swallows failures), so the picker could neither
add a second "Download started" toast without double-toasting nor tell success from failure. The
coordinator chose option (A): that one toast becomes

```
{ type: "success", title: "Download started", description: <downloadLabel(request)>, actionProps: { children: "Show", onClick: openDownloadTray } }
```

— one toast, for the picker's row menu, the title page's control, a card's menu and a season's
episodes alike, with the title as the description and the tray behind **Show**. No per-episode toasts
were added; season adds keep exactly the toasts they had. `lib/download-pick.ts` therefore adds no
toast of its own, and nothing double-toasts.

### `frontend/src/lib/downloads.test.ts` (one assertion, forced by the above)

`useDownloadActions`' test pinned the old wording (`title: "Downloading Breaking Bad · S1 E2"`). It
now asserts `{ type: "success", title: "Download started", description: "Breaking Bad · S1 E2",
actionProps: { children: "Show", onClick: expect.any(Function) } }`. Nothing else in that file
changed. (It is outside the files the task listed me; without it the merged suite fails on a change
the coordinator asked for.)

## Part 5: the same bug elsewhere — checked, nothing to fix

Every menu already reads the record's **state**, never its existence:

| Where | What it says | Verdict |
| --- | --- | --- |
| Title page `DownloadAction` (`components/title/title-page.tsx`) | `downloadControl` → `statusText` ("Queued", "Downloading 42 %", "Downloaded"), glyph from `statusOf` | honest |
| Episode menu (`components/title/episode-list.tsx`, `DownloadMenuItems`) | disabled `statusText` line, Resume for paused/failed, Remove; row glyph from `statusOf` | honest |
| Card menu (`components/media/title-menu.tsx`, `CardDownloadItems`) | `downloadRows` → `status: statusText(download)` | honest |
| Phone title sheet (`components/title/title-more.tsx`, `DownloadItems`) | disabled `statusText` line, Resume, Remove | honest |
| Season menu and buttons (`components/title/episodes.tsx`) | "Download season" (only the episodes with no record) and "Remove season downloads" — no claim that anything is downloaded | honest |
| `lib/title-actions.ts` | no download code at all (library, watched, progress, Continue Watching only) | — |

So no "status text while unfinished" or "Show downloads" item was needed there; the only stream-side
lie was the picker's row menu. (The player's stream switcher's "Downloaded" entry comes from
`Downloads.Playable`, which Go answers only for finished records.)

## Tests

`frontend/src/routes/downloads-entry.test.tsx` — a new `describe("a stream row's download menu")`,
reusing the file's existing setup (real `lib/downloads` + `lib/download-pick` over a mocked
`@bindings/downloads`, Cinemeta/Torrentio fixtures, `renderApp(pickerPath)`):

- a record with `state: "downloading"`, `bytes: 40`, `total: 100` → the menu shows the disabled
  "Downloading · 40 %" item and **not** "Downloaded"; "Show downloads" calls the mocked
  `openDownloadTray` (`vi.mock("@/lib/download-tray", …)` with `vi.hoisted` spy — the mock also
  exports `setDownloadTrayOpen` and `useDownloadTrayOpen: () => false`, so the shell compiles against
  it).
- "Cancel download" calls `Downloads.Delete(1, [record.id])` (via the file's `mocks.remove`).
- a `state: "done"` record → "Downloaded" and "Play downloaded copy" are there, "Download this
  stream" is not.

`frontend/src/lib/download-pick.test.ts` — four cases for `downloadOf` (same video and link whatever
the state; not another link; not another video, and nothing without a video id; the newest of two
records for the same stream) and one for `pendingOf` (only its own candidate's key, never null).

No casts, no `mockResolvedValue` on the bindings, `vi.fn<…>()` with type parameters, helpers at
module scope.

## Deviations from the spec, with the reason

1. **The start toast lives in `lib/downloads.ts`, not in `DownloadAdder` / `useStreamDownloads`'s
   done callback.** Reasons above: the shared action already toasted on success and cannot report
   failure to its caller, so a picker-side toast would have double-toasted and fired on failure too.
   The coordinator approved option (A) and widened my files for that toast only.
2. **The status words are composed, not `statusText` verbatim**, for `downloading` and `paused`:
   the spec wants "Downloading · 40 %" / "Paused · 40 %" with a middle dot, and `statusText` says
   "Downloading 40 %" and a bare "Paused". `queued`/`waiting`/`done` use `statusText` as it is, and
   `failed` uses `reasonText(state.reason)` behind "Download failed: ".
3. **Remove download confirms** (the spec's first option) rather than a confirm-less toast. The
   dialog is a sibling of the context menu in `RowMenu`, opened from a menu item as the menu closes;
   on the phone that means the sheet closes and the dialog opens. Worth one manual look — jsdom
   cannot tell me whether the focus hand-over between the two overlays feels right. If it doesn't,
   the fallback in the spec (no confirm, toast "Download removed") is a two-line change.
4. **The glyph's `aria-label` is `statusText`, not the bare percent** — "Downloading 40 %" instead of
   "40 %", and "Queued" / "Waiting for Wi-Fi" / "Paused" / "Downloaded" for the rest, which is the
   part the spec left open for the non-running states. "Play downloaded copy" is also only offered
   when the record's `contentType` narrows to a film or a series (channels have no player target).
5. **The slot is reserved on every row** (a 16 px `size-4` box), as asked, so rows without a download
   have a small empty gap on the badges line where a mark will appear.

## Open questions

- Should the finished "Remove download" toast say anything when it succeeds? The title page says
  nothing (the dialog closing plus the row losing its mark is the feedback); the row menu does the
  same. A "Download removed" toast without Undo would be honest but noisy, and it would need
  `lib/downloads`, which I only own for the add toast.
- The row glyph is drawn in the picker only. The player's stream switcher could show the same mark on
  the local copy's row; out of scope here (`components/player`).
- Nothing was checked on a device or in a real window: the sheet → dialog hand-over, the ring at
  small sizes, and the toast's Show action (which needs part A's/B's tray to be mounted) are all
  jsdom-blind.
