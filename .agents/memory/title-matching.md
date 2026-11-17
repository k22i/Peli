---
name: title-matching
description: "#99/ADR-0049 title mismatch: TMDB aliases via useTmdbAliases + titleContext 5th arg, titleCoverage in fakes.ts (report only), `titles` corpus split with manual aliases, measurement script, what to do with a TMDB key"
metadata:
  type: project
---

#99 (ADR-0049, built 2026-11-06): TMDB's `alternative_titles` + `translations` (same details request as the title page) become `TitleContext.aliases`; `fakes.ts` `titleCoverage`/`titleMismatch` compare words in every script (kana/Han in pairs, accents and apostrophes folded, articles in six languages ignored) and flag a release under 0.5 of the best title's words. **It is still report only**: `judge()` leaves `title mismatch` out of the bucket.

**Why:** the user has no TMDB key, so the check couldn't be measured with real titles; they chose "build it anyway". With the hand-aliased corpus it flags 27 of 32 wrong-title rows but moves 6.6% of genuine streams on the gate rows (English-only titles), so it can't count without TMDB's aliases. `hidden` was out (7–10% genuine hidden vs 1%); `hiddenRecallMin` stays at #100's 75.

**How to apply:**
- Aliases: `parseTmdbAliases` / `TmdbArt.aliases` / `useTmdbAliases(tmdbRef(...))` in `lib/tmdb.ts`; query key is `["tmdb", media, id, "aliases"]` (the suffix retires older persisted answers). `titleContext(type, video, meta, name, { map, aliases })` merges aliases with Kitsu's `meta.aliases` (map is #100's). Used by `useStreamChoices` (picker and player switcher) and `usePreparedNext`. Any test that renders those must mock `@bindings/secrets` (`Get`): `routes/player.test.tsx` now does.
- Corpus: `labelled.json` rows with `split: "titles"` (290, 27 titles `m-*`, Torrentio only) carry only `fake`, `localized`, CAM/TS `source`; `fieldRows(rows)` is the 492 rows (360 + #100's longrun) that the field accuracy, the CI gate, `engine.test` and `timing.test` use. Titles carry `aliasesSource: "manual"`: replace with TMDB's when a key exists.
- Re-record/re-label: `node src/record.ts matching [slug,slug]` in `spikes/stream-ranking` (public Torrentio, no key; a slug list adds titles without re-recording, since label ids are stream indexes), labels in `labels/title-matching.jsonl`, `frontend/scripts/extract-title-matching-corpus.ts` appends them (re-runnable). `extract-ranking-corpus.ts` rewrites the whole file: run the other after it.
- Measuring without vitest: a scratchpad Bun script calls `labelled`, `fakeRates`, `titleCheckRates`, `report` from `accuracy.ts` and writes `corpus/accuracy.md` (the "Title check" table has the suspicious/hidden estimates). Import `accuracy.ts` by absolute path from the scratchpad.
- Turning it on is in ADR-0049 ("what to do once a TMDB key is available"): aliases from TMDB, ≤ 2% of genuine localized rows moved, count it only when TMDB's aliases are in the context.
- When it starts counting, also make `useStreamChoices().answered` wait for the aliases, so #101's pre-resolve doesn't fire before a late re-rank ([[pre-resolve]]).
- Open finding: `wrong year` hides genuine streams when Cinemeta's year is the local release year (Spirited Away 2003, City of God 2004; 21 of 258 genuine rows in the split). TMDB's `release_date` may fix it; not changed (a #51 check).
- Related: [[stream-ranking]], [[tmdb-key]], [[anime-from-anilist]].
