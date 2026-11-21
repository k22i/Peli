# Downloads part 4: the frontend library (#85)

Not run (the task forbids it): the coordinator runs `pnpm typecheck`, `pnpm lint`, `pnpm fmt` and the
tests after merging. `@bindings/downloads` and `@bindings/store` are git-ignored and not in this
worktree, so the imports below are against the appendix's generated shapes.

## What changed

- `lib/downloads.ts` (new): everything parts 5–9 import.
  - `Downloads` (`Service` of `@bindings/downloads`) re-exported, with `Download` and the models
    (`AddRequest`, `Playable`, `Usage`, `Progress`, `Removed`, `SubtitleRef`, `LocalSubtitle`,
    `Network`), the three event names, and `formatBytes`.
  - Keys and queries: `downloadsRoot`, `downloadsKey(profileId)`, `downloadsQuery(profileId)`
    (`null` → `[]`, `enabled` only with a profile), `downloadUsageKey`/`downloadUsageQuery`,
    `downloadNetworkKey`/`downloadNetworkQuery`, `playableKey(profileId, videoId)`/`playableQuery`
    (`staleTime: 0`).
  - Hooks: `useDownloadEvents()` (mount once), `useDownloads`, `useDownload`, `downloadFor`,
    `useDownloadUsage`, `usePlayable`, `useDownloadRate`, `useDownloadActions`.
  - Helpers: `statusOf`, `percent`, `statusText`, `reasonText`, `downloadErrorText`,
    `downloadLabel`, `downloadable`, `addRequestFor`, `subtitleRefs`.
- `lib/bytes.ts` (new): `formatBytes`, moved out of `lib/torrent.ts` so downloads show sizes without
  importing the torrent bindings. `lib/torrent.ts` imports it and re-exports it, so
  `routes/settings.tsx` is unchanged.
- `test/setup.ts`: a `@bindings/downloads` mock, its whole factory inside `vi.mock` (no app module is
  imported at the top of setup — `.agents/memory/test-suite-green.md`). Every `Service` call
  resolves a `CancellablePromise` (`Object.assign(Promise.resolve(x), { cancel: vi.fn() })`):
  `List → []`, `Get`/`Playable → null`, `Usage → {used: 0, cap: 50e9, free: 100e9,
  dir: "/tmp/Peli/Downloads"}`, `Network → {online: true, expensive: false}`, `ChooseFolder → ""`,
  the rest `undefined`. Nothing is reset in `afterEach` because that file resets no other binding
  mock (and `restoreMocks` is on in `vite.config.ts`).
- `lib/downloads.test.ts` (new): `statusOf`, `percent`, `statusText`, `reasonText`,
  `downloadErrorText`, `downloadLabel`, `downloadFor`, `downloadable`, `subtitleRefs`,
  `addRequestFor` (a film, an episode, and a stream with no headers), and the event hook against a
  real `QueryClient`: upsert into the matching profile's list only, a new record appended, progress
  patching bytes/total plus `useDownloadRate`, a known size kept when the server sends none,
  removal dropping ids and invalidating usage and playable, `ids: null` ignored, and every listener
  gone on unmount. `@wailsio/runtime` `Events` is mocked as in `lib/party.test.ts`.

## How the events reach the cache

`useDownloadEvents` walks the query cache for `["downloads", <profileId>]` entries (any profile,
so a changed record lands where it belongs) and:

- `downloads:changed`: `setQueryData` with the record upserted by id (appended if new), clears that
  job's rate unless it is still `downloading`, then invalidates `["downloads", "usage"]` and
  `["downloads", "playable", <profile>, <video>]`.
- `downloads:progress`: patches `bytes`, and `total` only when Go sends one, in every list (ids are
  unique, so only the owning list matches); the rate goes to a module-level `Map` read through
  `useDownloadRate(id)` (`useSyncExternalStore`), so 500 ms events re-render only speed readouts.
- `downloads:removed`: filters the ids out of every list, clears their rates, invalidates usage and
  the whole `["downloads", "playable"]` prefix (the payload carries no profile or video).

## Deviations from ADR-0064's interfaces

- **`subtitleRefs(addonSubtitles, profileLanguage)` instead of `saveSubtitlesFor(profileId, target,
  profileLanguage)`.** The addon subtitles come from `useAddonSubtitles`, a hook, so it cannot be
  called outside React; `subtitleRefs` is the pure half — it reuses `lib/subtitles`'
  `subtitleLanguage` to take only the profile's language, the addons' order (best match first),
  `http(s)` links only, at most 10 (as `downloads.Add` keeps).
  **For part 6:** call `const { subtitles } = useAddonSubtitles(profileId, subtitleTarget(...))` in
  the component that owns the Download action, `useRef` it into the handler, and pass
  `subtitleRefs(subtitles, settings?.subtitleLanguage ?? "")` as `addRequestFor`'s `subtitles`.
  `autoSubtitle` is not what you want here: it applies the captions setting and the file's own
  tracks, and a download has no tracks yet.
- **`percent` rounds** to a whole 0–100 (an integer for a bar's width and for "Downloading 42 %"),
  rather than a fraction. `undefined` when `total <= 0`; clamped otherwise.
- **`usePlayable(profileId, videoId)`** is an extra hook (the ADR lists only `playableQuery`): parts
  5, 6 and 9 all ask it before resolving, and it needs the `enabled` guard.
- **`downloadLabel(download)`** is an extra one-liner ("Breaking Bad · S1 E3" / the film's name),
  used by the `add` toast and handy for rows.
- **`useDownloadActions`'s five functions return a `Promise<void>` that resolves either way** (the
  failure toast has already been shown). Parts 6 and 7 need to await adds in order ("Download
  season" queues episodes in creation order) without a rejection stopping the run.
- **`add`'s toast names the request, not Go's answer:** "Downloading <name · S1 E3>" from the
  `AddRequest` itself, "Added to downloads" when the request has no name. Go answers with the record,
  but the name is the same and a test's mocked `Add` needn't return one.
- `reasonText` also covers `invalid` and `not_found` (ADR error codes the part's list leaves to the
  generic fallback); anything unknown still says "Something went wrong".
- **`formatBytes` lives in `lib/bytes.ts`**, re-exported by `lib/torrent.ts` and by
  `lib/downloads.ts`.

## Open questions

- **Part 9 (and 7) must mount `useDownloadEvents()` exactly once** — in the shell, next to
  `useSyncEvents`. Until then, nothing in the app follows the events; the lists refetch on mount.
- `downloadNetworkQuery` is not polled: `Network()` is read when a screen mounts. If part 7 needs
  "Waiting for Wi-Fi" to clear the moment the path changes, Go would have to emit it (no such event
  in the ADR) or the view polls `refetchInterval`.
- `downloadsQuery` keeps TanStack's default `staleTime: 0`, so the Downloads view refetches its list
  on every mount; the events make that cheap, but a part 7 that remounts often may want `gcTime`
  and `staleTime` raised.
