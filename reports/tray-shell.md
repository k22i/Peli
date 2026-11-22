# Downloads tray part B: the button in the top bar, and its popover / sheet

Branch `k22i/tray-shell`, re-cut from `main` at `53f4ae3` ("style: format the tray files") for
round 1 of review fixes. Code and unit tests only; nothing was run (no tests, typecheck, lint,
`vp fmt`, build or `wails3`), per the rules — the coordinator runs all of that after merging. Go
is untouched.

## What changed

- **`frontend/src/components/shell/download-status.tsx`** (new) — `DownloadStatus()`:
  - **When it shows.** Reads the current profile (`currentProfileQuery`, `useQuery`) and
    `useDownloads(profileId)`. Shown while any download is unfinished (`statusOf(d) !== "done"`),
    while a done download finished in this app session is unseen, and while the tray is open.
    Module-level `startedAt` (the module's evaluation, i.e. the app) and `seenAt` (set to
    `Date.now()` in an effect when `useDownloadTrayOpen()` turns true). Unseen is
    `doneAt > seenAt && doneAt > startedAt`.
  - **The button.** A 28 pt round glass button (`size-7 rounded-full bg-foreground/8
    text-foreground/80`, hover/`data-popup-open` states, `focus-visible` ring) with the other
    pills' `pointer-coarse:after` 44 pt hit area (a centred `size-11` pseudo-element, so a
    finger's target doesn't change what is drawn). `ArrowDown` from lucide sits inside a
    circular SVG ring: a track plus an arc at `overallPercent(...)`; with no total known the
    whole ring turns slowly (`motion-safe:animate-spin` with a 2.4 s
    `[animation-duration:2.4s]`, `motion-reduce:animate-none`). When everything is done it is a
    lucide `Check` with a small `bg-sun` sun dot as the unseen badge (`data-slot="download-unseen"`).
    aria-label: `Downloads, 2 in progress, 42 %`, or without a total `Downloads, 1 in progress`,
    or `Downloads, 1 finished`.
  - **Desktop and iPad** (`useCompactShell()` false): a Base UI `Popover`
    (`@base-ui/react/popover`: `Root` + `Trigger` + `Portal` + `Positioner` + `Popup`),
    `side="bottom" align="end" sideOffset={8}`, popup `material-pop w-96
    max-w-[calc(100vw-2rem)] rounded-2xl shadow-pop`, scaling/fading in and out as the other
    popups do (opacity only under Reduce Motion). Its `open` is `useDownloadTrayOpen()` and its
    `onOpenChange` is `setDownloadTrayOpen`, so anything else (the stream menu's "Download
    started" toast) opens the same tray. Inside: `<DownloadTrayList profileId touch={false}
    onNavigate={close} />`.
  - **iPhone** (`useCompactShell() && isTouch()`): the same list in the existing `BottomSheet`,
    `label="Downloads"`, `touch`, closed through `onNavigate`. The tap that opens it is
    `haptic("light")`.
  - **Finished toast.** `useFinishedToasts(downloads, touch, play)` keeps a ref of each
    download's last status; a change to `done` with `doneAt > startedAt` adds one toast through
    `toastManager` — title "Downloaded", description `downloadLabel(download)` ("Severance · S1
    E2" for an episode, the film's name alone otherwise), `actionProps: { children: "Play" }`
    calling `usePlay()` with `{ type: contentType, id: contentId, title: name, videoId }`. On the
    iPhone it also calls `haptic("success")`. A download already done when the app opened is
    never news. The player screen has no top bar, so nothing toasts there.
  - Kids profiles: nothing special, per the spec.
- **`frontend/src/components/shell/top-bar.tsx`** — one import and `<DownloadStatus />` right
  before `<ProfileMenu />` in the bar's trailing cluster, so it is beside the profile on every
  shell shape (desktop, iPad, the iPhone's compact bar).
- **`frontend/src/components/shell/download-status.test.tsx`** (new) — seven tests, rendering
  `DownloadStatus` in a fresh `QueryClient` and the real `ToastProvider`:
  - hidden with no downloads (and the query is asked for the profile);
  - shown with a downloading one, aria-label "Downloads, 1 in progress, 42 %", clicking it opens
    the tray (the stubbed list's markup) and the tray's own row closes it (`onNavigate`);
  - no total known → "Downloads, 1 in progress";
  - a download finished while the app is open → the check with the unseen dot, not the ring;
  - a download finished *before* the app opened → no button and no toast;
  - `onCompactIOS()` → the sheet, `role="dialog"` named "Downloads" with `touch`, plus
    `haptic("light")`;
  - a done transition (a `setQueryData` patch, as `downloads:changed` does) → the "Downloaded"
    toast with description and Play, the exact `usePlay` target, and `haptic("success")`.

## Files touched

| File | |
|---|---|
| `frontend/src/components/shell/download-status.tsx` | new: `DownloadStatus`, `useFinishedToasts`, `StatusIcon`, `downloadsName`, `closeTray` |
| `frontend/src/components/shell/download-status.test.tsx` | new: the button's tests |
| `frontend/src/components/shell/top-bar.tsx` | the import and the one mount line |
| `reports/tray-shell.md` | this report |

Nothing outside those. `lib/download-tray.ts`, `lib/downloads.ts`, `components/ui/*` and
`components/downloads/tray-list.tsx` are used exactly as they are, not edited.

## Round 1 lint fixes

Three `vp check` findings in my own files, all style, no behaviour change. Nothing was run to
confirm them (per the rules); the coordinator's next `vp check` is the check.

- **`eslint(no-shadow)` in `download-status.test.tsx:76,77,79`** — the mocked
  `overallPercent` named its lambda parameters `download`, which shadows the file's own
  `download()` record builder. They are `item` now:
  `list.filter((item) => item.state !== "done")` and the two `reduce` sums. The mock computes
  exactly what it did before.
- **`unicorn(consistent-function-scoping)` in `download-status.tsx:195`** — `const close = () =>
  setDownloadTrayOpen(false)` captured nothing from `DownloadStatus`, so it is now a
  module-scope `function closeTray(): void` beside `downloadsName` ("a row that leads somewhere
  closes the tray it was in"). Both `onNavigate` props take `closeTray`. It is a stable function
  reference, so the sheet and the popover no longer rebuild a prop each render either.
- **`typescript(no-floating-promises)` in `download-status.test.tsx:237`** — `act(() =>
  client.setQueryData(...))` returned TanStack's promise-like callback result. It has a block
  body now, so `act`'s callback returns `undefined`.

Not mine, left alone: `tray-list.tsx`'s `Date.now()` in render (purity) and `role="progressbar"`
(a11y), `stream-list.tsx`'s two `role="img"`, and `download-pick.test.ts`'s `candidateOf`.

## Deviations from the spec, and why

- **The tray stays mounted while the button hides.** Instead of returning `null` from
  `DownloadStatus` when there is nothing to show, only the *button* is conditional; the popover
  and the sheet stay mounted with `open={false}`. Otherwise opening the tray marks everything
  seen, the button hides on the very same render the tray closes, and the popover/sheet would be
  torn out mid-exit instead of animating away (the sheet has no time to slide down). Extra
  consequence: Base UI returns focus to a trigger that may just have unmounted, so focus falls
  back to the document rather than to the button — the same thing that happens in the bar when
  the "update ready" pill disappears after a restart prompt.
- **`overallPercent(downloads)`, not `overallPercent(trayDownloads(downloads, now))`.** The ring
  reports every unfinished download of the profile; part A's `trayDownloads` is the tray's own
  windowing (what the list draws), and it would make the button's percent depend on the tray's
  policy. Easy to change to the tray list if the coordinator prefers it.
- **Haptics from a watcher effect.** `haptic("success")` is called inside the finished watcher
  rather than in a user gesture: a download finishing is an event, not a tap. It is guarded by
  the same ref that makes the toast fire once per download, so a re-render can't buzz twice
  (`lib/haptics`'s own note is about re-renders in gesture handlers).
- **The percent ring is the button's own circle** (a 28 pt `viewBox` drawn 11 pt out, arrow
  centred inside), not a smaller ring in a bigger button: the spec asks for a 28 pt button and
  the ring's arc needs the room to read at that size.
- **`shadow-pop` in addition to `material-pop`.** `material-pop` already sets
  `--shadow-pop`, so the class is redundant; it is there because the spec names it.

## Dependencies on part A and on the merge

- **`@/components/downloads/tray-list` is part A's file** (`DownloadTrayList`, `overallPercent`;
  I import nothing else from it). It did not exist in my round-0 worktree, so round 0 could not
  run at all; since the re-cut onto `53f4ae3` it is present, and its exports line up with
  what I import and pass (`profileId`, `touch`, `onNavigate`). The tests still `vi.mock` it with
  a stub list, a real-looking `overallPercent` and a `trayDownloads` passthrough, so they test my
  button and not part A's body.
- **The shell now reads the downloads query.** `useDownloads(1)` is shared with any screen's
  (same `["downloads", profileId]` key), so route tests that mock `Downloads.List` with a
  *running* download will also render the top-bar button. I checked the existing queries that
  could go ambiguous: `downloads-view.test.tsx` and its neighbours scope their button/tab
  queries with `within(...)` or by role (`tab`, `heading`), and no test counts the bar's
  buttons globally, so nothing should collide — worth a glance when the suite runs.

## Open questions

Settled in round 1 by the coordinator, so the build stands unchanged: the seen mark may be set
when the tray opens, and the button hides once nothing is unfinished and nothing is unseen. The
four below are still open.

- **An iPhone sheet that closes onto a hidden button.** With `onNavigate` closing the sheet after
  a Play, the button may hide in the same commit; the sheet keeps its exit animation (see the
  deviation above) but focus lands on the document body. If the user should keep a visible target
  there, the tray's "seen" mark could wait until the sheet has finished closing.
- **Should the check also show when nothing is unseen?** As specified, the button hides once
  every finished download has been looked at, so a user who wants the tray back to replay
  something has to reach it through Library › Downloads. A "keep it while anything is downloaded"
  rule is a one-line change if the coordinator wants it.
- **Popover keyboard behaviour** (Escape, focus back to the trigger, arrow keys) is Base UI's
  default; it isn't tested here because it is the component library's, and the suite can't run in
  this worktree.
- **Base UI `Popover` is used for the first time in this repo** (no other file imports
  `@base-ui/react/popover`). If the merge's `pnpm check` disagrees with the part names above
  (`Root`/`Trigger`/`Portal`/`Positioner`/`Popup`), that is the one place to fix; the classes and
  behaviour follow `components/ui/menu.tsx`.
