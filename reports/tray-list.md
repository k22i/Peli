# Downloads tray, part A: the tray's list (#85 follow-up)

Not run (the task forbids it): the coordinator runs `pnpm typecheck`, `pnpm lint`, `pnpm fmt` and the
tests after merging. `@bindings/downloads` and `@bindings/store` are git-ignored and absent from this
worktree, so the imports are written against `lib/downloads.ts` (part 4) and the shapes the existing
downloads tests already use.

## Round 1 fixes

- **`react(purity)` at `tray-list.tsx:84`**: the 24 h window no longer reads `Date.now()` during the
  render. A local `useMinute()` hook holds the clock (`useState(() => Date.now())`, then a 60 s
  `setInterval`, cleared on unmount) and `trayDownloads(downloads, now)` is given that — so the
  render stays pure and a row that reaches a day old drops out on its own.
- **`jsx-a11y(prefer-tag-over-role)` at `tray-list.tsx:346`**: the row's bar is a real
  `<progress value max={100}>` instead of `role="progressbar"` on a `span`, and the oxlint-disable is
  gone. It is drawn with `appearance-none` plus `::-webkit-progress-bar` (the track) and
  `::-webkit-progress-value` (`bg-sun`, rounded) — the pseudo-elements WebKit (macOS, iOS) and
  Chromium (WebView2) both give a `<progress>`.
- **The bar's test reads `value`, not `aria-valuenow`**: `toHaveProperty("value", 42)` on
  `getByRole("progressbar", { name: "Heat progress" })`. Checked outside this worktree (jsdom plus
  `@testing-library/dom` from another project, since this one has no `node_modules`): a
  `<progress aria-label value max>` is found by that role and query, and its `value` reads back 42
  whether React writes it as the attribute or the property.
- **Test `goes to the Library's downloads from See all and from a finished row`**: the component
  already renders a real `Link` named "Show in Library"; the failure was the test's, not the row's.
  `useDownloads` answers `data ?? []`, so the empty state (with the header's "See all") is there on
  the first render, and `findByRole("link", { name: "See all" })` resolved against it before the list
  arrived — the synchronous `getByRole` for the row's link then had nothing to find. It waits now
  (`await screen.findByRole(…, { name: "Show in Library" })`).
- **Test `lists only today's finished downloads, the newest first`**: the label is right — an
  episode's Play says "Play Breaking Bad · S1 E2" — and the fixture was wrong: `download()` is a
  finished *episode*, so a record named "New Film" was still an episode with a season. Added a
  `film()` fixture (the same record with `season: 0`, `episode: 0`, `contentType: "movie"`,
  `episodeName: ""`) and the two records in that test use it, so "Play New Film" is a film's Play.

## What changed

- **`frontend/src/components/downloads/tray-list.tsx`** (new): what part B mounts inside the ~24rem
  popover (desktop, iPad) and the iPhone's bottom sheet.
  - `trayDownloads(list, now)`: everything not `done`, in the order Go gave it (the queue's creation
    order, as the Library view shows it), then the done ones whose `doneAt || updatedAt` is within 24 h
    of `now`, newest first. A done record with no `doneAt` is measured from `updatedAt`.
  - `overallPercent(list)`: `sum(bytes)/sum(total)` over the unfinished rows that know their total,
    rounded and clamped; `undefined` when none does (or nothing is unfinished).
  - `DownloadTrayList({ profileId, touch, onNavigate })`, exactly the fixed interface: `useDownloads`,
    `useDownloadActions`, `usePlay` and `useOpenTitle`, then `trayDownloads(downloads, useMinute())`.
  - Root is a plain `div` (`flex flex-col gap-2 p-3`, `data-slot="download-tray"`): the material is
    part B's. The header is `<h2>Downloads</h2>`, the summary line ("2 downloading · 1.7 GB of
    5.0 GB", `formatBytes`, `tnum`; "All done" when nothing is unfinished; no summary line in the
    empty state), and "See all" as a `Link` to `/library?view=downloads` styled with
    `buttonVariants({ variant: "ghost", size: "sm" })`; its click calls `onNavigate`.
  - Rows sit in a `<ul className="max-h-[60vh] overflow-y-auto">` (about six rows of a 24rem
    popover), one `<li data-download={id}>` each: a `w-11` 2:3 `Artwork` (`use="poster"`, no
    `showTitle` — 44 pt is too small for the display serif, so its slate is the placeholder), the
    name as its own button (`aria-label="Open <label>"` → `useOpenTitle`, with the record's season),
    "S1 · E2 · Episode name" for an episode (`tnum` on the code, as the Library row has it).
  - Unfinished rows: a `<progress value={percent} max={100}>` bar (`appearance-none`, the track from
    `bg-foreground/12` and `::-webkit-progress-bar`, the amber fill from `bg-sun` and
    `::-webkit-progress-value`) and the meta line from `percent`, `formatBytes` and `useDownloadRate` —
    "42 % · 1.2 GB of 2.9 GB · 8.4 MB/s", the speed only while the state is `downloading`, otherwise
    `statusText` ("Waiting for Wi-Fi", "Paused", "Failed: …"). No percent or size until the server
    has given a total. Done rows show the size alone ("2.9 GB").
  - Actions: downloading/queued/waiting → Pause + Cancel; paused → Resume + Cancel; failed → Retry
    (which is `resume`) + Cancel. Icon buttons with `aria-label`s naming the download
    (`downloadLabel`). Cancel calls `actions.remove([id])` at once, as the Library view does. Done
    rows: a primary Play (`size="sm"`, filled icon) that calls `onNavigate()` and then
    `play({ type: contentType, id: contentId, title: name, videoId })`, and a "Show in Library"
    `Link` to `/library?view=downloads` that calls `onNavigate` first. Nothing is hover-only at rest.
  - `touch` (the iPhone sheet): rows get `min-h-11`, the icon buttons `size-11`, Play `h-11 px-4`,
    the two links `h-11` hit areas, and the row hover tint is dropped.
  - Empty state (`rows.length === 0`): the same header without a summary, "No downloads" and
    "Download a film or an episode from its page or a stream’s menu.", with See all in the header.
- **`frontend/src/components/downloads/tray-list.test.tsx`** (new): no casts, and the setup is a
  component test's — `QueryClient` plus a memory router with `/` (the tray), `/library` and
  `/title/$type/$id`, since the tray's links and title rows navigate. `@bindings/downloads` is the
  shared mock from `test/setup.ts`, overridden per test with
  `vi.mocked(Downloads.List).mockImplementation(() => CancellablePromise.resolve<Download[] | null>(…))`
  (`test/setup.ts`'s `cancels` shape, as `routes/downloads-home.test.tsx` does it); `@bindings/store`
  is `{ Service: {} }` (`lib/addon-protocol/queries.test.ts`'s pattern) and `@/lib/playback` is mocked
  to a hoisted `vi.fn` so the play target can be read. Tests: `trayDownloads` ordering (unfinished in
  Go's order above today's finished, newest first), the 24 h cut-off including the exact boundary and
  the `updatedAt` fallback; `overallPercent` (the share of known totals, the `undefined` cases, a row
  with no total left out); and the render: the header summary and "42 % · 1.2 GB of 2.9 GB" with the
  bar's `value` at 42 (a real `<progress>` named "Heat progress") and the done row's size, "All done",
  Resume/Retry/Pause reaching the Service,
  Cancel calling `Downloads.Delete(1, ["b1"])` with no dialog, Play with the play target and
  `onNavigate` before it, the row's name opening `/title/series/tt0903747` without playing, the two
  links' hrefs and See all calling `onNavigate`, the empty state, and an old finished download left
  out.

## Files touched

- `frontend/src/components/downloads/tray-list.tsx` (new)
- `frontend/src/components/downloads/tray-list.test.tsx` (new)
- `reports/tray-list.md` (this file)

Nothing else: the tray flag (`lib/download-tray.ts`), `lib/downloads.ts`, the Library view and the
shell are untouched.

## Deviations from this part's spec

- **Active rows keep Go's order instead of "newest first".** "Everything not done, plus done ones
  finished within the last 24 h, newest first" is read as: the done ones newest first, the active
  ones in the queue's creation order, which is how the Library's Downloads view lists them and the
  order Go runs them in. Sorting a running job above a paused one would hide the queue.
- **"Show in Library" sits under Play in the row's action column** rather than after the text: a
  24rem popover has no room for both a primary button and a text link beside the title, and the
  action column keeps the two done-row actions together.
- **A "Downloads" heading is still shown in the empty state**, with the See all link in its header
  row, because the spec puts See all in the empty state too — so the empty state is the header plus
  the two lines, not the two lines alone.
- **`Artwork` is used without `showTitle`.** The placeholder a poster-less title gets is the
  component's own hue slate (the "neutral placeholder" this app has); at 44 pt the display-serif
  title would be unreadable. A download has no second image to fall back to, so `fallback` is unused.
- **The tray's own "All done" summary is `summaryText` (local), while `overallPercent` is only
  exported for part B's button.** The header wants bytes ("1.7 GB of 5.0 GB"), not a percent.
- **Tray rows are `li`s with buttons, not a `listbox`**: no Shift/⌘ selection here, unlike the
  Library view, so no option semantics.

## Open questions

- The "N downloading" count counts every unfinished row, so a tray with one paused and one queued
  download says "2 downloading". If the user would rather see the state split
  ("1 downloading · 1 paused"), it is one line in `summaryText`.
- Pause is offered on a `queued` download, as the Library view offers it: `internal/downloads` is
  assumed to pause a job that hasn't started (it is what the Library view already does).
- ~~The 24 h window is computed per render (`Date.now()`)~~ — closed in round 1: `useMinute()` ticks
  the clock once a minute, so a tray left open across the cut-off drops the row within a minute and
  the render stays pure.
- Cancel goes straight to `remove` with no confirmation even for a download that has bytes on disk,
  matching the Library view; the tray has no Undo, and an Undo would be a re-download.
- **A cold open can flash the empty state.** `useDownloads` returns `[]` both while the list is
  pending and when it is empty, so a tray opened with a cold cache shows "No downloads" for the
  length of the call (the Library view reads `useQuery(downloadsQuery(...))` and shows skeletons
  instead). The list is persisted and the shell mounts `useDownloadEvents`, so it is only the very
  first open after a relaunch; if it is worth it, part B or a follow-up can read `isPending` and hold
  the rows back rather than add a skeleton to a 24rem popover.
- Nothing was run or seen in a real window. The 60vh/24rem proportions and the touch hit areas are
  from the app's tokens, not measured.
- No `.agents/memory/` entry was written (the task lists my files, and the memory index is shared):
  the coordinator may want one for the tray part, naming `components/downloads/tray-list.tsx`,
  `trayDownloads`/`overallPercent`, and that the list is "unfinished + the last 24 h".
