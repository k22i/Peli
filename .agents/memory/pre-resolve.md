---
name: pre-resolve
description: "#101 (ADR-0060) opt-in pre-resolve of the picker's cached top pick: DeviceSettings.preResolve, lib/pre-resolve.ts usePreResolve/take, rules (cached debrid link only, pick alone, once, 5 min stale, never kids), ttff -app numbers and recipe, TorBox side effect"
metadata:
  type: project
---

#101 (ADR-0060): "Start cached streams sooner" = `DeviceSettings.preResolve` (off by default; Settings › Streaming › "Starting" group). The picker calls `usePreResolve(view.top, {enabled: device.preResolve && !profile.kids, answered, refresh})` (`lib/pre-resolve.ts`). Once `useStreamChoices().answered` is true (every source answered, plus meta, episode map, remembered source and device loaded) and the top pick has held for 500 ms, it resolves `{...top, alternates: []}` through `resolvePick`. `pick()` calls `ahead.take(candidate)` first and falls back to `resolvePick` with the copies if that rejects.

**Why:** the user chose opt-in, off by default (2026-11-17), because resolving a Torrentio+TorBox stream adds it to their TorBox list even if it never plays. The resolve is ~2 s of server time, and pre-resolving is the only way to reach the 3 s target ([[stream-resolve]] has the scrapped hand-off).

**How to apply:**
- Rules: only `preResolvable` picks resolve ahead (cached === true, a debrid service, `stream.url`, not a `plugin:` source). One at a time, and each key (source + url) at most once per visit. Dropped on a new top pick, another pick or unmount. Stale 5 min after it resolved. Once taken, a top-pick change doesn't abort it.
- Numbers (2026-11-17, `ttff -app`, 50 Mbit/s, VideoToolbox, 3 s look): plain median 4.43 s (n 14, worst 6.12 s); ahead 1.35 s (n 14, worst 2.41 s, all ≤ 3 s). The load was also ~0.7 s faster after a resolve ahead (CDN edge warmed by Resolve's ranged GET, most likely).
- Recipe: `go build -o <scratch>/ttff ./tools/ttff`, then `set -a; . ~/Developer/staysh/spikes/stream-ranking/.env; set +a; PELI_MPV_OPTIONS=mute=yes caffeinate -i <scratch>/ttff -app -ids series/tt1190634:1:1,… -hash <full hashes, comma-separated> -mode alternate -look 3s -mbps 50`. The `.env` is in the main checkout, not in worktrees. IMDb ids: The Boys tt1190634 (S1, 8), Summer I Turned Pretty tt14016500 (S3, 11), Widow's Bay tt33332385 (S1, 10). It opens a window, so the screen must be unlocked. Python's `urllib` has no CA store here: use curl.
- All 29 episodes of those packs were used cold on 2026-11-17. Wait a few days before the next cold A/B. Diff `/v1/api/torrents/mylist` before and after (109 entries then, none added).
- Gap: `answered` doesn't wait for TMDB aliases (`useTmdbAliases` has no pending state). Harmless while `title mismatch` is report-only ([[title-matching]]), but when it starts counting, add the aliases' loading to `answered`, or a late re-rank could pre-resolve a second stream (a second debrid entry).
- Tests: `lib/pre-resolve.test.ts` (fake timers, injected `resolve`, `now`); `streams.test.tsx` "starting cached streams sooner" (real timers, a 900 ms "looking" wait); `settings.test.tsx` switch test.
- Related: [[next-episode]] (usePreparedNext, same approach, no setting), [[stream-picker]], [[stream-preferences]], [[debrid-test-key]].
