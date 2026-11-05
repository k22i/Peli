---
name: remembered-source
description: "#58 remembered stream source (ADR-0044): store.ChosenSource per profile+show, Prefs.remembered → engine #best via lib/ranking/remembered.ts, lib/chosen-source.ts save on every play, 'Same source as last time' label, mocks; read before touching the top pick, the next-episode card or the store's sources bucket"
metadata:
  type: project
---

#58 (ADR-0044): a show's last source is a fingerprint `{source key, resolution, group}` in Go `store.ChosenSource` (`profiles/<id>/sources/<content id>`, local only, series only). The frontend reads `chosenSourceQuery(profileId, showId)` (`lib/chosen-source.ts`) and passes `remembered(...)` as the second argument of `rankingPrefs(settings, remembered)`. `StreamEngine.#best()` then returns `rememberedPick` (`lib/ranking/remembered.ts`). The rules: quality must match, then group +2 / addon (or any alternate's) +1; never collapsed tiers; never above the device's resolution cap (#98, `rememberedPick`'s 4th argument, passed `prefs.maxResolution`); never uncached when the best is cached. It doesn't change the score, and pins still hold.

**Why:** one place for the rule, so the picker, the switcher and `usePreparedNext` agree (the #68 hand-off asked for that). The override is any pick, because `rememberSource` runs after every successful `Player.Load` (picker, switchStream, playNext).

**How to apply:**
- `useStreamChoices` returns `usual(candidate)`. `StreamList`'s `usual` prop adds "· Same source as last time" after "Top pick" (the text still starts with "Top pick").
- `usePreparedNext` waits for `chosen.isPending` to be false before it settles on a pick.
- Route tests that render the picker or the player must mock `ChosenSource` / `SetChosenSource` in `@bindings/store` (`mocks.chosen` resolves null by default in streams/player tests).
- Committed 2026-11-05 with its tests written but not run, so #58 stays open until they pass.
- Related: [[stream-ranking]], [[stream-picker]], [[stream-switcher]], [[next-episode]].
