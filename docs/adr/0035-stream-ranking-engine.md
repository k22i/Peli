---
status: accepted
date: 2026-10-30
---

# Stream ranking: our own parser and ranker, in a Web Worker, fed slice by slice

#51 builds the engine that ranks, groups and de-fakes streams (F15), starting from the M0 spike ([#6](../spikes/stream-ranking.md)). It's a pure TypeScript module in `frontend/src/lib/ranking/`, our own code, with no ranking or release-name library. The spike's code was ported, typed for the app's strict settings and fixed where #6 said it fell short.

## Layout

| File | |
|---|---|
| `parse.ts` | One stream → resolution, HDR10 / HDR10+ / DV, codecs, audio and channels, Atmos, size, source, release group, audio languages, season / episode, pack, debrid service and cache state, info hash, file name, seeders, extras. Reads `name`, `description` / `title`, `behaviorHints.filename` and `videoSize`, and Peerflix's top-level fields. |
| `fakes.ts` | `judge()`: the #6 heuristics give reasons, and the reasons a bucket: `ok`, `suspicious`, `low quality` (CAM / TS / TC / screener) or `hidden`. |
| `score.ts` | `defaultWeights` (every weight, in one place), `scoreStream()`, tiers, de-dup keys, `Candidate`. |
| `engine.ts` | `StreamEngine` (incremental `add`, `view`, `pinTop`, `takeChanges`) and `rankStreams()` for a whole list at once. |
| `context.ts` | `TitleContext` from the title's details and the video id. |
| `protocol.ts`, `worker.ts`, `ranker.ts` | The worker, its messages, and `RankingSession`, the page's side. |
| `accuracy.ts`, `corpus/` | The labelled corpus and the accuracy gate. |

## Ranking

As #6 set it: **cached on debrid first, then quality, then a plausible size**. Each band is wide enough that a lower one can't overturn a higher one, so a cached 720p beats an uncached 4K remux. The weights are hand-set, in `defaultWeights`, and not user-facing.

**Groups:** 4K · 1080p (with 1440p) · 720p · SD · Unknown · Low quality · Likely fake. The last two start collapsed. The **top pick** is the best stream outside them. Ties fall back to arrival order, so the list doesn't reshuffle at random.

**De-duplication:** the same info hash and file, or else the same file name with a size within 1%. The copy that plays soonest is kept (cached debrid, uncached debrid, P2P, then score); the others become its `alternates`, as fallbacks if it fails to resolve.

**Likely fakes:** another season or episode, extras, a non-video file, a file too small for the runtime, the wrong year, or an episode for a film. **Suspicious** (shown, ranked 3,000 lower): too large for its source. A **title mismatch** is reported but moves nothing: #6 found it wrong 22 times out of 26 against English titles, since releases use localized ones. It should count, as suspicious, once the metadata gives translated titles (TMDB's `alternative_titles` and `translations`), measured on the corpus first. [ADR-0049](0049-title-matching-with-tmdb-titles.md) builds that (TMDB's names as aliases, a title check that reads every script) and measures it on a hand-aliased corpus; it stays report only until a TMDB key allows the real measurement.

**Preferences** (`Prefs`): the profile's audio language (`ProfileSettings.audioLanguage`), and HDR when the display reports `(dynamic-range: high)`. Dolby Vision can't be detected from a webview, so it's off. The resolution isn't capped: a 4K encode still looks better on a 1440p or 1600p panel, and the cap needs a setting of its own. Both wait for that setting. (Update, ADR-0048: #98 added the device settings for the cap, HDR and Dolby Vision, and the profile's audio languages became an ordered list.)

## One engine

The same `Stream` shape and the same engine serve:

- **The picker (#52)**, through the worker: `useRankedStreams(sources, ctx, prefs)` in `lib/streams.ts` feeds it every slice from `useStreamFeed` and returns the view and `pin()`.
- **Plugin results (#56)**: add them as another source, tagged with the plugin's id instead of an addon URL.
- **The next-episode auto-pick (#58) and the in-player switcher (#68)**: `rankStreams(ctx, answers, prefs)` when every answer is already in, or a `RankingSession` while they arrive.

## Incremental, in a Web Worker

`StreamEngine.add()` parses and sorts only the new streams, then merges them into the sorted list. `pinTop()` keeps the highlighted pick once the user starts navigating, even if a better stream arrives later. The picker pins it on the first focus or pointer-down in the list.

The engine runs in **one Web Worker** shared by every picker (`new Worker(new URL("./worker.ts", import.meta.url), { type: "module" })`, emitted as its own chunk). Each picker is a session. Streams go in once; what comes back names them by arrival number, so an update carries only the candidates that are new or changed, plus the order as keys. The page puts the streams back in. If there's no `Worker` (jsdom) or the worker fails to load, the same code runs on the page, and open sessions start again there.

The title page **warms the worker up** (`warmRanking()`): it ranks a made-up answer of 60 streams twice, so the slow first run (26–35 ms, before the JIT has the code) is over before Play.

The picker doesn't wait for the title's details or the profile's settings. It ranks with what it has (the id, the heading's name) and **starts the session again with every slice so far** when either arrives. Usually they're cached and nothing restarts. A pin carries over.

## Accuracy: the CI gate

`corpus/labelled.json` holds the 360 hand-labelled streams from #6 and their titles, copied by `scripts/extract-ranking-corpus.ts`; their debrid keys were already redacted. `accuracy.test.ts` checks each field and the fake checks against #6's targets in every CI run, and writes `corpus/accuracy.md` with the numbers per split and every miss, so a parser change shows as a diff in review.

Over all 360 (#6's numbers in brackets):

| Field | Now | #6 | Target |
|---|---:|---:|---:|
| Resolution, HDR, video codec, audio codec, channels, Atmos, cached | 100% | 100% | 95–100% |
| Size | 99.7% | 99.7% | ≥ 98% |
| Source | 100% | 98.9% | ≥ 93% |
| Release group | 94.4% | 92.2% | ≥ 85% |
| Audio languages (exact set) | 96.4% | 95.3% | ≥ 80% |
| Season / episode | 99.4% / 99.7% | 99.4% / 99.2% | ≥ 97% / 95% |
| Pack | 96.4% | 96.1% | ≥ 90% |
| Hidden, false-positive rate | 0% | 0% | ≤ 1% |
| Hidden, recall | 63.2% | 63% | ≥ 60% |
| CAM / TS recall / false-positive rate | 100% / 0% | 100% / 0% | ≥ 95% / ≤ 1% |

What changed, from #6's list of misses: subtitle lists such as Erai-raws' `[ENG][POR-BR][SPA-LA]…` aren't read as audio languages; `TSScreener`, `FullBluray` and `BD1080p` are read as sources; release groups after subtitle words (`… Subs KINGDOM`), with a second tag (`FLUX-PSOTNIK HT`) or a trailing emoji are found, and site tags (`katmovie-hd.nl`), sizes (`1GB`), numbers and single letters aren't taken for groups; `S1 - 01` and `Show_-_01_` episodes are read. Cache markers are read for every service Torrentio and Comet name (`TB RD AD PM DL ED OC PP`, with or without the emoji's variation selector), and only those, so a `[EN]` tag isn't a debrid service. The CAM / TS check also no longer counted a label that accepts `["ts", "scr"]` as a miss.

**These fixes were made with every split visible**, including the blind one, so the blind split is no longer blind. New labels should be drawn and labelled before the change they test, as #6 asked, especially for AllDebrid and Premiumize markers (only TorBox was recorded), wrong-title fakes and addons not yet in the corpus.

## Speed

On the reference machine (M1 Pro), over the whole recorded corpus of #6 (20 titles, 20,453 streams), with the machine in use:

| | V8 (Node 26.3) | JavaScriptCore (Bun 1.3.10) |
|---|---|---|
| **~200 streams at once** (a title's first 200), median / p95 / max | **5.2 / 6.9 / 10.8 ms** | **6.7 / 9.3 / 16.3 ms** |
| One 150-stream slice and the view, median / p95 / max | 2.7 / 4.3 / 8.2 ms | 3.5 / 5.4 / 25 ms |
| A whole title in slices (287–2,170 streams), median / p95 | 22 / 47 ms | 27 / 60 ms |
| Cold, ~200 streams | 30 ms | 31 ms |

So the ≤ 16 ms target for ~200 streams holds at p95 on both. In **headless Chrome with the real worker**, Dune: Part Two's 2,170 streams from five addons (1,313 after de-dup) in 17 slices were all ranked 69–90 ms after the last slice was sent, 3.5 ms median per slice in the worker, and the page's longest gap between frames was 17 ms.

`RANKING_TIMING=1 vp test run src/lib/ranking/timing.test.ts --silent=false` repeats the V8 numbers; it's skipped in CI, since times depend on the machine. Vitest doesn't run under Bun, so the JavaScriptCore column came from the same loop in a plain Bun script. Not yet measured: inside WKWebView, WebView2 and WebKitGTK themselves, and a low-end machine.

## The picker until #52

The provisional picker (ADR-0034) now lists the ranked view: the top pick first, labelled "Top pick", then each stream with its tier, and a button for the collapsed groups ("Show 23 CAM / TS and 70 likely fake"). The summary counts unique streams. Picking one still says the player isn't built. #52 has since replaced the list with the real design: badges, a one-key play, the raw file name on demand only ([ADR-0036](0036-stream-picker.md)).

## Never logged

Stream URLs embed the user's debrid key. The engine reads the hash out of a URL but doesn't keep, show or log the URL; the corpus's keys were redacted when #6 recorded it.
