---
status: accepted
date: 2026-11-06
---

# Anime episode map: the Kitsu addon's season and absolute numbers, asked beside the details, judged in the fake checks

#100 closes the gap #6 left in the fake checks (gotcha 7, ADR-0035): Kitsu ids count a long runner's episodes absolutely (One Piece `kitsu:12:1100`), while releases name the same episode `1100`, `S01E1100`, `S22E15`, `21x109`, or put it in a `Season 20 - Wano` folder. Without a map from one numbering to the other, a "S01" pack or `S22E15` couldn't be judged, so neither was flagged and One Piece episode 1100 showed season packs, the 2023 live-action series and other seasons' episodes among its streams.

## The source: the Kitsu addon's videos

Candidates, checked against One Piece, Detective Conan, Naruto Shippuden and Dandadan's second season:

| Source | Keyless | Result |
|---|:---:|---|
| **Kitsu addon** (`anime-kitsu.strem.fun`) `meta` → `videos[]` | yes | Each video has `imdbSeason`, `imdbEpisode` and `absoluteEpisode`. One Piece 1100 is S22E15 (the `S22E15` the nekoBT release names), 1000 is S21E109 (`21x109`), Conan 1100 is S31E33, Conan 500 is S17E10, Naruto Shippuden 300 is S14E05, Dandadan 2nd Season episode 1 is S02E01 / 13. 1,410 videos for One Piece, 1,585 for Conan, answered in the same call as the details. |
| Kitsu API `episodes` | yes | `seasonNumber` is 1 for every One Piece episode and `airdate` is null for 1100: no map. |
| Kitsu API `mappings` | yes | Gives the TVDB / AniDB / MAL ids of the whole show, not each episode's season. |
| AniList addon (built in, #108) `videos` | yes | `season: 1`, `episode: n` for all, from Kitsu's list. No map. |
| TMDB episode groups | no | Needs the user's own key ([`tmdb-key`](../../.agents/memory/tmdb-key.md)); none was available, so it stays an optional extra. |

**The Kitsu addon's videos win:** no key, one request that is usually cached for the title page, and the numbers match what releases say in all five cases we checked (labelled rows name them: `S22E15`, `S21E109`, `21x109`, `17x72`, `S14E05`, `S17E10`).

The AniList addon usually answers a title's details first (ADR-0045), so the map isn't read from that answer. `useEpisodeMap` (`lib/episode-map.ts`) asks the addons that serve the title's details one at a time (their answers are the title page's, mostly cached) until one has the numbers for the video. It only asks for `kitsu:` videos. The picker's `useStreamChoices` and the next-episode card's `usePreparedNext` pass it to `titleContext(…, map)`; ranking starts without it and starts again when it arrives, as it does for the details. A user with no Kitsu addon has no map and keeps today's behaviour.

## The check

`TitleContext.map` is `{ season, episode, absolute }` of the asked-for video. In `judge()` for Kitsu ids, `mappedNumbering()` replaces the old rule when there is a map:

- **A file** is the episode when it says the map's season and episode (`S22E15`); or the absolute number with no season, season 1, the map's season, or any season when the absolute number differs from the season's (a long runner: `Season 20 - Wano/… 1000`, `Season 14 Voyage 09`); or Kitsu's own number with no season. Otherwise it is a **wrong episode** (no season, or the map's) or a **wrong season**.
- **A season pack** (a season and no episode) is kept when it is the map's season, when a season range in its names covers it (`S01-S22`, `Seasons 16 to 21`), or, for long runners, when an episode range covers the absolute number (`0001-1118`, `E40-E928`, `S01e296-300`) or the file name carries it. Any other season is a **wrong season**.
- Episode ranges and releases with neither a season nor an episode aren't judged, as before.

Dandadan's second season shows why the map isn't only for long runners: its Kitsu episode 1 is `S02E01`, and `S01E01` is now the first season's episode, not a match.

**Without a map the old rule stays**: `S02+` with Kitsu's episode number is a wrong season, a bare other number is a wrong episode, and everything else isn't flagged. The parser and the weights are unchanged.

## Measured

The ticket said to label before changing the check. 132 streams were recorded (Torrentio, Torrentio + TorBox, TorrentsDB and Comet + TorBox `/stream` answers, keys redacted, no TorBox resolve) for One Piece 700 and 1000, Detective Conan 500 and 1100 and Naruto Shippuden 300, sampled with a seed, and labelled by reading the names (`0c2a807`). They are the `longrun` split (90 genuine, 42 fake); the 360 original rows and their splits are unchanged. The check came in the next commit.

| | Before | After |
|---|---:|---:|
| Original 360 rows: hidden false-positive rate | 0% | 0% |
| Original 360 rows: hidden recall | 63.2% | **78.9%** |
| `longrun` (132): hidden false-positive rate | 3.3% (3 of 90) | **1.1%** (1) |
| `longrun`: hidden recall | 14.3% (6 of 42) | **85.7%** (36) |
| All 492: hidden false-positive rate | 0.7% | 0.2% |
| All 492: hidden recall | 37.5% | 82.5% |

Two of the three false positives before were the old rule's: a `Season 14 Voyage 09` folder and `S14E300` read as another season. The one left is the parser's: `Naruto.Shippuden.E300.mkv` in a torrent called "Épisodes 1 à 453" is read as episode 453. `S22E15` for One Piece 1100 stays visible, and so do `21x109`, `S14E05` and the folder-season files. The six fakes still shown: two One Piece specials (*Fan Letter*, the anniversary special), a Detective Conan film, a PC game (a title mismatch, which doesn't count), the Ocean Cut re-edit whose `S14E05` is another episode, and a "1ª à 13ª Temporadas" pack the parser can't read. `hiddenRecallMin` went from 60 to 75.

The new rows lower no field below its target (`pack` is at 90.7% over all rows, 75% over `longrun`: the parser reads a season folder as a pack; the target holds).

## Not done

- The label sample has no single episode of another season (`S20E15`) that an addon sent for a long runner; those cases are covered by unit tests, not by recorded rows. TorrentsDB, which mislabels seasons, answered nothing for One Piece or Conan.
- IMDb's and TVDB's seasons can differ for a show (One Piece, Conan and Naruto matched); the map is IMDb's through the Kitsu addon. A show where the release uses TVDB's numbering and they differ would hide a genuine file. The labelled shows are the evidence so far.
- The AniList addon has no map. Giving it one (from Kitsu's list and the IMDb id) would remove the second request and the dependency on the Kitsu addon.
- A TMDB-episode-group source for users who have a key.
