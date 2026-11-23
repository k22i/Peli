---
name: preferred-quality-autoplay
description: Profile settings preferredQuality (soft ranking preference under the device cap) and autoplayTopPick (a status screen instead of the list while it finds and opens the top pick; list on failure; `choose` in the address stops it)
metadata:
  type: project
---

Built 2026-11-23 by mistral-vibe workers (code only), checked and merged by the coordinator.

- `ProfileSettings.PreferredQuality` (`best|2160p|1080p|720p`, default `best`, `store.PreferredQualities`) and `AutoplayTopPick` (default off). Old records read as `best` because `ProfileSettings()` decodes onto the defaults.
- Ranking: `rankingPrefs` sets `Prefs.preferredResolution` via `preferredResolutionOf(settings, cap)` (null for best, or when the preference is above the device cap). In `scoreStream`, a stream above the preference scores as the preferred resolution minus `abovePreferred` (250). In `tierOrder`, tiers above the preference that still fit the cap come right after the preferred tier. The cap ([[stream-preferences]]) and the cached band still win.
- Autoplay (reworked 2026-11-23, the list must never show while it runs): `useAutoplay` in `streams-page.tsx` is a status machine `finding → opening → list` (state moves are set while rendering, not in an effect, so the list never paints for a frame). While `finding`/`opening`, the Picker renders `AutoplayPick` (a `PickScreen`, shared with the guest's `GuestPick`, `data-slot="autoplay"`, status in an `<output>`): "Finding the best stream…" + Choose myself, then "Opening 1080p from Torrentio…" + Cancel; both show the list. While the profile settings are pending (and `choose` wasn't in the address at open) the page shows a spinner, not the list. `choose` is read once at mount (`chooseAtOpen`), because the autoplay itself replaces the address with `choose: true` as it starts opening (so a fallback list doesn't autoplay again). When the autoplay plays, the player **replaces** the picker in history (`replace: isIOS() || report !== undefined`): the user never saw the list, so Back lands where Play was pressed (user asked 2026-11-23). `PickScreen`'s Ambient is `fixed inset-0` so the sunrise sits on the window's bottom edge, not 4rem above it. Nothing to play (no top once `answered`) or a failed resolve / `Player.Load` lands on the list with `AutoplayNotice` above it. Stands down for a guest, with `choose`, on Choose myself / Cancel; the P key does nothing while the screen shows.
- Picks report through `OpeningReport` (`status`/`failed`/`close`): a toast for the user's pick, the autoplay screen for the profile's; `pick` returns `PickOutcome` (`played|failed|cancelled`).
- `answered` now includes `caughtUp` from `useRankedStreams`: the view has ranked every fed slice with the current ctx/prefs (`RankingSession.waiting` counts adds still owed, pins aside; `useStreamFeed` returns whether a source answered that isn't fed yet). Without it the autoplay fired on a stale top pick from before the last addon's slice was ranked.
- `choose: true` is passed by "Choose a stream…" (title menu) and by the player's `chooseNext(true)` when the next episode had no stream ("none") or wouldn't open; Episodes-sheet picks and "Play now" while still finding autoplay as usual.
- Settings › Streaming: "Preferred quality" comes before Maximum resolution; "Autoplay the top pick" sits beside "Start cached streams sooner".
- `streams.test.tsx` builds its profile from the shared `profileSettings()` fixture, so `Player.Load` expectations include `subtitleStyle`.

**Why:** the user asked for one quality preference for every title, plus an always-autoplay option.

**How to apply:** for other ranking preferences, follow the `preferredResolution` pattern (an optional Prefs field, so Prefs literals keep compiling). Any new way into the picker that must show the list should pass `choose: true`.
