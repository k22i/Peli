# Downloads part 8: Settings › Downloads (#85, ADR-0064)

Not run (the task forbids it): the coordinator runs `pnpm typecheck`, `pnpm lint`, `pnpm fmt` and the
tests after merging. `@bindings/downloads` and `@bindings/store` are git-ignored and absent from this
worktree, so the pane is written against the appendix's generated shapes.

## What changed

- **`components/settings/downloads-pane.tsx` (new).** `DownloadsPane({ title, profileId })` with the
  lead "Downloads stay on this device and play without a connection.", a `Skeleton` until the profile
  and the device's settings are both there, then one group of device rows and, below it, the
  destructive one:
  - **Location** (desktop only, `feature("downloadFolder")`, hidden from kids): the folder
    `useDownloadUsage().dir` (truncated, with a `title`), "Change…" → `Downloads.ChooseFolder(profileId)`
    then invalidating `["settings","device"]` and `["downloads","usage"]`, `""` meaning cancelled and
    changing nothing; "Use default" (only while `downloadsDir` is set) saving `downloadsDir: ""`. The
    row's description is the ticket's "New downloads go here. Ones you have stay where they are."
  - **Storage limit**: a `ResponsiveSelect` over `downloadCaps` = `[10, 25, 50, 100, 250, 500]`
    (Go's `store.DownloadCaps`), saving `downloadsCapGB`, its description the usage line
    `formatBytes(used) used · formatBytes(free) free on this disk`.
  - **Download over Wi-Fi only** (iOS only, `feature("downloadsWiFiOnly")`): a `Switch` on
    `downloadsWiFiOnly`, described as "Downloads wait for Wi-Fi instead of using mobile data."
  - **Delete all downloads** (hidden from kids): a `destructive-outline` "Delete all…" that opens an
    `AlertDialog` — "Delete all downloads on this device?" / "Every profile's downloads are removed."
    — whose confirm button is `destructive`; it calls `useDownloadActions(profileId).removeAll()`
    (Go's `DeleteAll`). Disabled while `usage.used === 0` and while the usage is still loading.
  - The pane owns its save path: `useQuery(deviceSettingsQuery)` + `useSaveDeviceSettings()` from
    `lib/settings`, saving whole records the way every other device row does.
- **`components/settings/panes.ts`.** `downloads` added to `allPanes` (title "Downloads", lucide
  `Download`, tone `bg-[#5856d6]`), after Streaming; and to the phone's middle `paneGroups` card, so it
  is reachable at compact width too, not only in `?section=`.
- **`routes/settings.tsx`.** One import and one `case "downloads"` in `Pane`, nothing else.
- **`lib/features.ts`.** `Feature` gains `"downloadFolder"` and `"downloadsWiFiOnly"`; `downloadFolder`
  joins `notOnIOS` (the phone has no folder dialog: `ChooseFolder` is `ErrUnsupported`), and a new
  `onlyOnIOS` set holds `downloadsWiFiOnly`, asked *before* the `notOnIOS` path, because `feature()`
  otherwise returns true off iOS. The type's two "other way round" entries share one comment now.
- **Tests.**
  - `lib/features.test.ts`: `downloadFolder` joins `outOnIOS` (so both existing cases cover it), and a
    new case checks `downloadsWiFiOnly` is off on the desktop and on at both iOS widths.
  - `routes/downloads-settings.test.tsx` (new, `renderApp("/settings?section=downloads")` with an
    in-memory Go store): the pane's lead and rows, the folder from the usage, no "Use default" with
    the default folder, no Wi-Fi row on the desktop, the cap showing `50 GB` and the usage line; the
    cap saving `downloadsCapGB`; "Change…" calling `ChooseFolder(2)` and asking the usage again;
    "Use default" saving `downloadsDir: ""` and asking it again; "Delete all…" showing the alert
    dialog, cancelling without calling `DeleteAll`, then confirming and calling `DeleteAll(2)`;
    "Delete all…" disabled at `used: 0`; on `onIOS()` the Wi-Fi switch (saving `downloadsWiFiOnly`)
    and no Location row; on a kids profile neither Location, "Change…" nor "Delete all…", with the cap
    still shown.
  - `routes/settings.test.tsx`: `paneTitles` gains "Downloads" where the pane list now puts it (the one
    edit to an existing test, needed by the new pane). The Playback → ArrowDown → Languages case is
    untouched because Downloads sits after Streaming.

## Files touched

| File | |
|---|---|
| `frontend/src/components/settings/downloads-pane.tsx` | new: the pane and its rows |
| `frontend/src/components/settings/panes.ts` | `downloads` entry, phone list group |
| `frontend/src/routes/settings.tsx` | the import and the `case` |
| `frontend/src/lib/features.ts` | two features, `onlyOnIOS` |
| `frontend/src/lib/features.test.ts` | `downloadFolder` in `outOnIOS`, the Wi-Fi case |
| `frontend/src/routes/downloads-settings.test.tsx` | new: the pane's tests |
| `frontend/src/routes/settings.test.tsx` | `paneTitles` only |

Nothing else changed; other parts' files were not touched.

## Deviations from ADR-0064 / the ticket

1. **"Delete all" goes through `useDownloadActions(profileId).removeAll()`**, not a bare
   `Downloads.DeleteAll(profileId)` call in the pane. Same Go call and argument; it also gets
   `lib/downloads`' refusal toast (`downloadErrorText`) and its invalidation of the list and the
   usage, so the pane doesn't re-implement either.
2. **The pane reads and saves the device settings itself**, instead of the route's `WithSettings`
   helper: that helper is local to `routes/settings.tsx`, and the task keeps that file to the import
   and the case. So the pane is self-contained — `Skeleton` until `deviceSettingsQuery` answers — and
   can be rendered by a test or another screen without the route around it. `PluginsPane` already
   works this way.
3. **The pane sits after Streaming, not after Playback.** Both read well; after Streaming the existing
   keyboard case in `settings.test.tsx` (Playback → ArrowDown → Languages & subtitles) keeps its order
   without being rewritten, which is the smaller diff. It also groups the two panes about how streams
   arrive and what is kept.
4. **`downloads` was added to `paneGroups`** (not asked for explicitly). Without it `visiblePaneGroups`
   drops the pane and it is unreachable in the phone's Settings list, which would contradict "it must
   be in `visiblePanes()` on iOS too" in spirit.
5. **The usage line uses `formatBytes`** (lib/bytes, as the torrent cache row does): "12 GB used ·
   210 GB free on this disk" for 12.3e9 bytes, since `formatBytes` shows a decimal only below 10 of a
   unit. The ticket's "12.3 GB" is the same number in more digits; matching the rest of Settings
   seemed worth the rounding.
6. **"Use default" also invalidates `["downloads","usage"]`** (the ticket only says so for "Change…"):
   the counted folder moves when the folder moves, and both go through one `refresh()`.
7. **Defensive reads of the new record fields**: `(device.downloadsDir ?? "") !== ""` and
   `device.downloadsWiFiOnly === true`, plus `capOf` falling back to 50 GB for a cap outside
   `downloadCaps`. Go always sends all three (defaults on decode), but other route tests' store mocks
   predate the fields, and a device record must never make this pane throw.
8. **`downloadCaps` is exported from the pane file** (the ticket says keep it there). It is not yet
   shared; see the open questions.

## Open questions

- **Who owns `downloadCaps` next?** The Library's Downloads view (part 7) or Home's row (part 9) may
  want to show the cap. Importing it from a settings pane is the wrong direction; it belongs in
  `lib/downloads.ts` beside `downloadUsageQuery`, which is outside my files. The coordinator may want
  to move the constant there and re-export it here.
- **A kids profile can still change the cap and the Wi-Fi switch.** The ticket hides only the folder
  and "Delete all", and Go's `SaveDeviceSettings` has no kids guard, so both rows stay — but a kid
  then moves a device-wide limit the parent set. If that is wrong, the fix is Go-side (a kids refusal)
  or hiding the cap too; the pane would only need one condition.
- **`Usage().cap` is unused here.** The cap row shows `device.downloadsCapGB` (what the user is
  choosing) while the usage query's `cap` is what Go is running with; they differ until the save
  returns. The pane trusts the settings record, as the torrent cache row does.
- **A settings row that opens a native folder dialog in a webview.** `ChooseFolder` blocks on the
  platform dialog; the button is disabled while it runs and a refusal is toasted, but on a slow disk
  the call can take a while with no progress. Worth a look on a device before release.
- `.agents/memory/` was not touched (outside this part's files): worth a line in `settings-panes.md`
  about the tenth pane, and one in a downloads note about `downloadCaps`.

## Fix round 1

Two things came back from the merge: a typecheck error in the pane, and two failing tests in
`routes/downloads-settings.test.tsx`. Still nothing run here (`pnpm typecheck`, `lint`, `fmt` and the
tests are the coordinator's), as the task asked.

### 1. `downloads-pane.tsx:99` — TS2379 under `exactOptionalPropertyTypes`

`save()` handed `{ onSuccess: after }` to `mutate` even when `after` was `undefined`, which
`exactOptionalPropertyTypes` refuses (an optional property may be absent, not `undefined`). It now
passes the option only when there is one:

```ts
const save = (change: Partial<DeviceSettings>, after?: () => void) =>
  saveDevice.mutate({ ...device, ...change }, after ? { onSuccess: after } : {});
```

### 2. The two iOS tests — the cause was not the usage line

The failure text (`Unable to find … 12 GB used · 210 GB free on this disk`) reads like a split or
mis-formatted line, but the DOM dumped in it is the router's **`ErrorScreen`**, with no shell around
it: `formatBytes(12_300_000_000)` really is `"12 GB"` (a decimal only below 10 of a unit), the line is
one text node in the row's description, and the text the test asks for is exactly what the pane
renders. Nothing was missing from the line — the pane never got to paint.

Both failing cases are the only two that turn `onIOS()` on, and on iOS **and with a profile in use**
the shell mounts `useSeedAudioLanguages` (`lib/device-languages.ts`), whose effect calls
`Store.SeedAudioLanguages(id, codes)` and only `.then(…).catch(…)`s the *promise*. This file's
`@bindings/store` mock listed eight methods and not that one, so the call threw a `TypeError`
synchronously inside an effect of `AppShell` — past the route's boundary, up to the root route's
`errorComponent` ("The shell itself failed: the same screen, with no shell around it",
`routes/__root.tsx`), which is the screen in the dump. On the desktop the effect returns at
`if (!isIOS())`, which is why every other case in the file was green; and it took `renderApp`'s first
paint to succeed, which is why the failure is the pane query and not the shell's `navigation`.

Every other route test that turns iOS on mocks the method already (`routes/player.test.tsx:185`,
`routes/downloads-playback.test.tsx:180`, `src/ios.test.tsx`), which is the rule in
`.agents/memory/test-suite-green.md`.

So the fix is in the test's mock, not in the pane: `SeedAudioLanguages` (the effect, fatal when
missing) plus `ContinueWatching`, `Library` and `VisibleAddons` (what `ProfileGate`'s icon-menu sync
asks once a profile is in use, through queries), each answering empty, with a comment saying why. The
two cases then reach the pane: the Wi-Fi switch renders, reads `false`, describes itself and saves
`downloadsWiFiOnly`; the folder row and "Change…" are absent.

| File | |
|---|---|
| `frontend/src/components/settings/downloads-pane.tsx` | `save()` passes `onSuccess` only when defined |
| `frontend/src/routes/downloads-settings.test.tsx` | the store mock gains the four binds the iOS shell calls |

`.agents/memory/test-suite-green.md` also gains one line, since a route test that turns `onIOS()` on
will hit this again.
