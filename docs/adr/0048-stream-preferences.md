---
status: accepted
date: 2026-11-06
---

# Stream preferences: device settings for resolution, HDR and Dolby Vision, and an ordered list of audio languages on the profile

#98 gives the ranking (ADR-0035, "Preferences") the three inputs it was waiting for: a resolution cap, Dolby Vision, and more than one audio language. The weights stay hidden. The labels describe the device.

## Where each setting lives

**Device settings** (`store.DeviceSettings`, local to the machine, next to hardware decoding):

| Setting | Values | Auto means |
|---|---|---|
| `maxResolution` | `auto`, `2160p` (4K), `1080p`, `720p` | No cap. It isn't derived from the screen's size: a 4K encode still looks better on a 1440p panel. 4K is the same as Auto for ranking and is there so the choice can be explicit. |
| `hdr` | `auto`, `on`, `off` | The display's `(dynamic-range: high)` report, as before. |
| `dolbyVision` | `auto`, `on`, `off` | Off. A webview can't tell and the player doesn't report it. |

They are device settings because they describe what this screen and player can show, not who is watching. Old records have none of the fields and read as `auto`, since settings decode over the defaults. Saving a value outside the lists is `ErrInvalidSettings`. They live in Settings › Streaming, in a "Picture" group above Torrents. If the player ever reports decode capability cheaply, Auto could use it. Not built.

**The audio languages** are on the profile (`ProfileSettings.audioLanguages`, ISO 639 codes, most preferred first, at most 8, none twice, none empty). Nothing in `ProfileSettings` syncs to Nuvio: no code reads or writes a language through `internal/nuvio`, so there is no single value to keep in step and the whole list is local. A profile saved with the old single `audioLanguage` reads as a list of one (`carryOverAudioLanguage`), and the next save drops the old key. The list is always an array on the wire, because Go's `nil` slice would reach the frontend as `null`. The frontend also reads `null` as none.

## How they reach the ranking

`rankingPrefs(profile, device, remembered)` in `lib/streams.ts` builds `Prefs`: `languages` from the list, `maxResolution` (`auto` → `2160p`), `hdr` and `dolbyVision` as in the table. Settings that haven't loaded count as their defaults. `useRankedStreams` already restarts its session when `prefs` change (it compares them by value), so the open picker, the player's switcher and the next-episode card re-rank as soon as a setting is saved. `usePreparedNext` reads the device settings itself.

The scoring already had `maxResolution`, `hdr`, `dolbyVision` and `languages`. Two edits, both small:

- **`aboveMaxResolution` is -30,000, was -6,000.** At -6,000 a cached 4K (10,000 + 4,000 - 6,000) still beat an uncached 1080p, so a stream over the cap didn't "rank below every stream that fits". The new value clears the widest gap: about 17,000 for the best stream over the cap against about -9,000 for the worst one that fits (dead swarm, wrong language, DV without a fallback).
- **The groups follow the cap.** `tierOrder(prefs)` moves the groups whose lowest resolution is above the cap to just before the collapsed ones, nearest to the cap first, so a 1080p cap lists 1080p, 720p, SD, Unknown, then 4K. The 1080p group holds 1440p too, so it stays where it is under a 1080p cap and its 1440p streams score lower inside it.

- **The remembered source respects the cap.** `rememberedPick` (ADR-0044) skips any candidate above `maxResolution`, as it skips collapsed groups. A show last played in 4K gets the ranked best under a 1080p cap, not the 4K match. The matching rules are otherwise unchanged.

With Dolby Vision off, `dvWithoutFallback` (-800) already put a DV-only stream below the same stream with an HDR10 layer and below plain SDR. Tests pin that.

## The player

`LoadOptions.audioLanguage` became `audioLanguages` (a list). Go joins it into mpv's `alang`, which already takes a list, so playback starts with the first language the file has. Every code is checked, and an empty entry is refused, as a comma would have been. A retry of the same file passes the language of the track that was playing, as a list of one.
