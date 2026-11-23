---
name: preferred-quality-autoplay
description: Profile settings preferredQuality (soft ranking preference under the device cap) and autoplayTopPick (picker plays the top pick once every source answers; `choose` in the address stops it)
metadata:
  type: project
---

Built 2026-11-23 by mistral-vibe workers (code only), checked and merged by the coordinator.

- `ProfileSettings.PreferredQuality` (`best|2160p|1080p|720p`, default `best`, `store.PreferredQualities`) and `AutoplayTopPick` (default off). Old records read as `best` because `ProfileSettings()` decodes onto the defaults.
- Ranking: `rankingPrefs` sets `Prefs.preferredResolution` via `preferredResolutionOf(settings, cap)` (null for best, or when the preference is above the device cap). In `scoreStream`, a stream above the preference scores as the preferred resolution minus `abovePreferred` (250). In `tierOrder`, tiers above the preference that still fit the cap come right after the preferred tier. The cap ([[stream-preferences]]) and the cached band still win.
- Autoplay: `useAutoplay` in `streams-page.tsx` waits for `answered` and a `view.top`. It first replaces the address with `choose: true` (`StreamsSearch.choose`, so Back from the player shows the list), then calls `pick`. It stands down for a guest, with `choose` in the address, when the user pins (moves in the list or picks), or on "Choose myself". The status line is an `<output>`.
- Settings › Streaming: "Preferred quality" comes before Maximum resolution; "Autoplay the top pick" sits beside "Start cached streams sooner".
- `streams.test.tsx` builds its profile from the shared `profileSettings()` fixture, so `Player.Load` expectations include `subtitleStyle`.

**Why:** the user asked for one quality preference for every title, plus an always-autoplay option.

**How to apply:** for other ranking preferences, follow the `preferredResolution` pattern (an optional Prefs field, so Prefs literals keep compiling). Any new way into the picker that must show the list should pass `choose: true`.
