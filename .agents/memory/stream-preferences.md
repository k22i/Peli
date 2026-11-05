---
name: stream-preferences
description: "#98 (ADR-0048) device maxResolution/hdr/dolbyVision + profile audioLanguages list: where they live, rankingPrefs(profile, device, remembered), -30,000 cap penalty + tierOrder, LoadOptions.audioLanguages, Settings UI, test gotchas"
metadata:
  type: project
---

#98 (ADR-0048): `DeviceSettings.maxResolution` (`auto|2160p|1080p|720p`), `hdr` and `dolbyVision` (`auto|on|off`) are device settings in Settings › Streaming › Picture (`QualityGroup` in `routes/settings.tsx`). `ProfileSettings.audioLanguage` became `audioLanguages` (ordered, max 8, local only: nothing in ProfileSettings syncs to Nuvio); `carryOverAudioLanguage` reads the old key. `rankingPrefs(profile, device, remembered)` in `lib/streams.ts` maps them: Auto cap → `2160p`, HDR auto → `(dynamic-range: high)`, DV auto → off. `LoadOptions.audioLanguages` is a list, joined for mpv's `alang`.

**Why:** the ticket's acceptance said a 1080p cap ranks 4K below every stream that fits; at the old -6,000 a cached 4K still beat an uncached 1080p, so `aboveMaxResolution` is -30,000. `tierOrder(prefs)` (score.ts, used by `StreamEngine.view`) lists over-cap groups after the fitting ones.

**How to apply:**
- A new field on either settings record: add it to Go defaults and validation, regenerate bindings, and add it to the full-object mocks in tests (`DeviceSettings`/`ProfileSettings` are typed there, so `pnpm check` finds the misses). Go nil slices reach the frontend as `null`: keep `AudioLanguages` non-nil (`[]string{}`), read with `audioLanguagesOf`.
- `AudioLanguagesRow` (`components/settings/audio-languages.tsx`): add Select, ordered list with move earlier/later/remove buttons (`aria-disabled` at the ends so focus stays), a live `<output>`; remove returns focus to the add control.
- Picker tests mock `DeviceSettings` in `@bindings/store`; the re-rank test sets `deviceSettingsQuery.queryKey` on the `renderApp` queryClient.
- `rememberedPick(..., maxResolution)` skips candidates above the cap (review fix), so a remembered 4K gives way to the ranked best under a 1080p cap ([[remembered-source]]); `resolutionOrder` is exported from `score.ts` for it.
- Tests were written, not run (worker rules); the screenshot rig is [[settings-panes]]'s: scratchpad stubs aliased by a throwaway `vite.shot98.config.ts`, `?res=`/`?langs=` in the hash drive the stub.
- Related: [[stream-ranking]], [[stream-picker]], [[remembered-source]], [[player-tracks]], [[hardware-decoding-hdr]].
