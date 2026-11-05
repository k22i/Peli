---
name: anime-episode-map
description: "#100/ADR-0050 episode map for long-running Kitsu anime: Kitsu addon videos imdbSeason/imdbEpisode/absoluteEpisode, useEpisodeMap, TitleContext.map, mappedNumbering in fakes.ts, longrun corpus split, numbers and gotchas"
metadata:
  type: project
---

Long-running anime asked by Kitsu's absolute number (`kitsu:12:1100`) are judged with an episode map (#100, ADR-0050): `TitleContext.map = { season, episode, absolute }` from the Kitsu addon's `meta.videos[]` (`imdbSeason`, `imdbEpisode`, `absoluteEpisode`; One Piece 1100 = S22E15). `judge()` calls `mappedNumbering()` (fakes.ts) for `kitsu:` ids when there is a map; without one the old rule is untouched.

**Why:** #6's gotcha 7: S01 packs and `S22E15` couldn't be judged, so they weren't flagged. The map hides season packs and other seasons' episodes and keeps `S22E15`, `S01E1100`, `Season 20/… 1000`, bare `1100`.

**How to apply:**
- The AniList addon answers details first and carries no map (`season: 1`, `episode: n`). `useEpisodeMap(addons, loading, type, id, video)` (`lib/episode-map.ts`) asks the addons serving meta in order until one's videos have the numbers; `episodeMapOf(meta, video)` is the pure reader. It's wired in `useStreamChoices` and `usePreparedNext`. A user without the Kitsu addon gets no map.
- `mappedNumbering` rules: file = map's S/E, or absolute number (any season when absolute ≠ the season's number), or Kitsu's number with no season; packs kept for the map's season, a season range (`S01-S22`) or, for long runners, an episode range / file name carrying the absolute number. Ranges of episodes and unnumbered releases aren't judged. The parser (not mine to change) gives a folder season (`Season 20 - Wano/…`) to the file, hence the "any season" clause.
- Corpus: 132 rows in split `longrun` (ids `addon/slug#n`, titles one-piece-e700/e1000, detective-conan-e500/e1100, naruto-shippuden-e300; title records carry `map`). The original 360 are unchanged. `accuracy.test.ts` counts 492 = 200/100/60/132; `hiddenRecallMin` is 75. Numbers: original hidden recall 63.2 → 78.9 %, FP 0 → 0 %; longrun recall 14.3 → 85.7 %, FP 3.3 → 1.1 %.
- Remaining misses: One Piece specials, a Conan film, a PC game, the Ocean Cut re-edit (its S14E05 is another episode), a "1ª à 13ª Temporadas" pack; one FP from the parser (`Naruto.Shippuden.E300.mkv` read as 453 because of "Épisodes 1 à 453").
- Re-measure without vitest: a Bun script in the scratchpad that imports `src/lib/ranking/accuracy.ts` and the corpus JSON, calls `labelled`, `fakeRates`, `report`, and writes `corpus/accuracy.md` (partition by `corpus.streams[i].split`).
- Recording: scratchpad Node script using `spikes/stream-ranking/src/redact.ts` and the main checkout's `.env` (`TORBOX_API_KEY`), `/stream/series/<kitsu id>.json` on Torrentio, TorrentsDB, Torrentio + TorBox, Comet + TorBox. TorrentsDB returned nothing for One Piece or Conan; Comet takes 6–30 s for these.
- Not done: IMDb vs TVDB season numbers may differ for some shows; the AniList addon has no map; TMDB episode groups (needs a key) as an optional source.
- Related: [[stream-ranking]], [[anime-from-anilist]], [[addon-protocol-client]], [[tmdb-key]], [[debrid-test-key]].
