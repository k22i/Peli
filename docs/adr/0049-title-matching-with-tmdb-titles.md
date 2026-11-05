---
status: accepted
date: 2026-11-06
---

# Title matching: TMDB's alternative and translated titles feed the ranking, report only until measured with a key

#99 follows up ADR-0035, which left "title mismatch" as a reported reason that moves no stream: against Cinemeta's English titles it was wrong 22 times out of 26 (#6), because releases use *Cadena perpetua*, *Les évadés*, *Kimi no Na wa*. ADR-0035 said it could count, as `suspicious`, once the metadata gives translated titles, **measured on the corpus first**.

The user has no TMDB key (ADR-0031: the key is the user's own), so that measurement can't be made with real TMDB titles yet. The user chose to **build it anyway**: the code path, the labelled corpus and the measurement tooling are done; the check stays report only.

## What is built

- **TMDB's names reach the ranking.** The details request the title page already makes (`/movie/<id>` or `/tv/<id>`) also asks for `alternative_titles` and `translations` in `append_to_response`. `parseTmdbAliases()` lists the original title, the alternative titles (`titles` for a film, `results` for a series) and the translated titles (`data.title` / `data.name`), once each, without the title's own name (at most 300). They sit on `TmdbArt.aliases`, and `useTmdbAliases(ref)` reads them from the same query, so nothing is asked twice. The query key gained a suffix (`["tmdb", media, id, "aliases"]`), so answers persisted before this change, which have no aliases, age out instead of being read as "none".
- **`titleContext(…, aliases)`** takes them as a fifth argument and merges them with the addon's own (Kitsu's `aliases`), dropping repeats and the name itself. The picker (`useStreamChoices`, which the player's switcher shares) and the next-episode prefetch pass them. With no key, or a title TMDB doesn't map (an unmapped Kitsu anime), the list is empty and the context is exactly what it was. The ranking session restarts once when the aliases arrive, as it does when the details do.
- **The title check** (`titleCoverage`, `titleMismatch` in `fakes.ts`) is rewritten:
  - Words are compared in **every script**. #6's check gave up on any Cyrillic, Thai, Japanese, Chinese or Korean release name; now *Побег из Шоушенка* is compared with TMDB's Russian title, and kana and Han, which have no spaces, are cut into pairs of characters.
  - Accents, apostrophes (*d'Amélie* is *damelie*, *Pan's* is *pans*) and articles in English, French, Spanish, Italian, German and Portuguese are ignored; single digits stay (*1+1*, *Cars 2*).
  - The measure is the **share of the best-matching title's words** that the release names have (the name, or any alias), and a release under 0.5 is a mismatch. #6's was "no word in common", which let *Spider-Man 2* pass for *Spider-Man: Brand New Day*. 0.34 caught the same fakes on the new rows and 3 fewer on the old ones; 0.67 added 3 genuine for 5 fakes.
  - The verdict is the same reason as before, `title mismatch`, and it **still moves nothing** (`judge()` leaves it out of the bucket). Nothing about the parser or the score weights changed.

## The corpus

Torrentio (public, no debrid) was recorded for 27 titles (`node src/record.ts matching` in the spike): 19 films and shows with other names in their releases, and 8 with short or generic names (*Heat*, *Alien*, *Joker*, *Split*, *Coco*, *Frozen*, *Us*, *Soul*), where fuzzy search answers with other films. 290 streams were labelled by reading release names, **before the check was changed** (the labels are their own commit), and appended to `labelled.json` as a new split, **`titles`**: 32 fakes (other films, sequels and shorts, a collection's other file, courses and clips), 258 genuine, 112 of those under another title than the name asked for (`localized`). The selection over-samples hard cases: streams whose names lack the English title, and each title's tail. The rates below are not what a user would see.

The `titles` rows carry only the labels the check needs (`fake`, `localized`, a CAM / TS `source`). They are left out of the field accuracy and of the CI gate, which still count the original 360 (200 / 100 / 60, unchanged), and report in their own column of `corpus/accuracy.md`.

**The aliases are hand-written.** For each title the aliases are the official localized titles I know (Spanish, French, German, Italian, Portuguese, Russian, Japanese, Korean, Chinese, and a few more), marked `aliasesSource: "manual"`. TMDB lists more languages, but also some junk, so these are stand-ins, not an upper or lower bound. They were written before the streams were read. Seven genuine rows use a language that has no alias (Swedish, Estonian, Serbian/Croatian, Czech, a title without spaces); TMDB would list some of those.

## Measured (hand-written aliases, new check)

`corpus/accuracy.md` has the full table. `suspicious` ranks a mismatch 3,000 lower; `hidden` puts it in the collapsed likely-fake group.

| | report only (shipping) | as `suspicious` | as `hidden` |
|---|---:|---:|---:|
| **titles split**, hidden false-positive rate | 8.1% | 8.1% | 10.5% |
| titles split, genuine localized rows suspicious or hidden | 13.4% | 18.8% | 18.8% |
| titles split, genuine rows moved by this check | 0% | 2.3% | 2.3% |
| titles split, fake recall (hidden) | 46.9% | 46.9% | 84.4% |
| titles split, fakes not `ok` (suspicious or hidden) | 15 of 32 | 27 of 32 | 27 of 32 |
| **original 360**, hidden false-positive rate | 0% | 0% | 8.4% |
| original 360, genuine rows moved by this check | 0% | 8.4% | 8.4% |
| original 360, fake recall (hidden) | 63.2% | 63.2% | 71.1% |

Against #6's check, on the same rows: it moved 4 of 32 fakes in the `titles` split and 2 of 38 in the old 360, now 12 and 3, for 6 genuine in the split (the same ones) and 22 → 27 of 322 in the old 360. The extra five are Chinese and Russian release names with no alias in the corpus, which the old check skipped as "non-Latin".

What it says:

- **The check finds fakes well**: it flags 27 of 32 wrong-title rows once the verdict counts, and it catches Russian, Chinese and Japanese release names for other films that #6's skipped.
- **Every genuine row it flags in the split is a language the title has no alias for**: all 7 are localized, none of the 146 genuine rows that name the title in English is flagged, and 105 of the 112 localized ones pass thanks to the aliases. So its precision depends on how complete TMDB's translations are, which can't be known without a key.
- **On the old 360, whose titles are English-only (no key), it flags 8.4% of genuine streams** (releases in other languages). That is the same problem as #6's 22 of 26, and the reason it can't count for people without a key.
- **`hidden` is out**: 8.4–10.5% genuine hidden against a limit of 1%. `hiddenRecallMin` stays 60; the 71.1% above isn't worth that. 
- **A finding outside the title check:** 21 of the split's 258 genuine rows are *hidden* (8.1%, the whole of the first row) by `wrong year`, not by the title check. Cinemeta's year is the local release year (Spirited Away 2003, City of God 2004), while releases carry the original one (2001, 2002). It is a #51 check, not changed here. TMDB's `release_date` is the original year, so a key should fix it too; worth a ticket.

## What to do once a TMDB key is available

1. Save a key (Settings › Integrations) and check `useTmdbAliases` on a real title: *Shawshank* should list *Cadena perpetua*, *Les Évadés* and *Побег из Шоушенка*.
2. **Replace the hand-written aliases**: fetch `alternative_titles` and `translations` for the 27 `titles` rows with `parseTmdbAliases` and write them into `labelled.json` (`aliasesSource: "tmdb"`). Keep the manual ones in git history. This is a scripted step that reads the key from the keychain or an env var, and never prints it.
3. Regenerate `corpus/accuracy.md` and read the **Title check** table. Count the rows that moved, and read each genuine one: it is either an alias TMDB lacks or a real problem.
4. Turn it on as `suspicious` only if, with TMDB's aliases, the check alone moves **at most 2%** of genuine localized rows and keeps most of the 27 fakes. Move `"title mismatch"` out of the `reasons.some((r) => r !== "title mismatch")` exclusion in `judge()`.
5. **Count it only when TMDB's aliases are in the context** (a title whose `aliases` came from TMDB). Without a key, the English-only check flags 8.4% of genuine streams, and that is not better than not checking. Keep a separate flag in `TitleContext` for it.
6. Leave `hidden` for a second step: it needs the false-positive rate (including the year problem above) under 1% on a larger, unselected sample. Raise `hiddenRecallMin` only if the measured recall with the check on `hidden` justifies it without the new check.

## What we give up

- **No effect for people without a key**, as before. ADR-0031's key stays optional.
- **A bigger details answer.** `translations` carries every language's overview too (tens of kB). Only the parsed result is kept.
- **The ranking restarts once** when the aliases arrive, even though the verdict is report only. It is cheap (a slice or two), and it means the day it counts, nothing else changes.
- **A small, selected, hand-labelled sample.** 32 fakes cannot give a recall figure to the nearest per cent; the figures are estimates to decide whether it is worth turning on, not targets.

## Verification

- Tests written, **not run**, as this ticket's rules say: `parseTmdbAliases` (film and series shapes, repeats, odd answers) and the aliases in `parseTmdbArt` (`lib/tmdb.test.ts`); `useTmdbAliases` with a key, without one, with no ref and with TMDB failing (`lib/tmdb-aliases.test.tsx`); `titleContext` aliases (`ranking/context.test.ts`); the title check (`ranking/fakes.test.ts`: localized title passes with the alias and flags without it, other films in three scripts, pack names, report only, the half-of-the-words rule); the `titles` split's count (`ranking/accuracy.test.ts`). The title route's TMDB URLs in `routes/title.test.tsx` now name the two extra parts; the player route test mocks `@bindings/secrets`.
- `corpus/accuracy.md` and the figures above came from a Bun script that loads the corpus and calls `labelled`, `fakeRates`, `titleCheckRates` and `report` from `accuracy.ts`, so the snapshot is what the test writes.
- Not checked live: no TMDB key, so `alternative_titles` / `translations` were never fetched. The response shapes follow TMDB's documented ones (`alternative_titles.titles` for films and `.results` for series, `translations.translations[].data.title` / `.name`).
