# Spike: our own stream parser and ranker

Issue: [#6](https://github.com/k22i/Staysh/issues/6) · Epic: [#1](https://github.com/k22i/Staysh/issues/1) · Feeds: [#51](https://github.com/k22i/Staysh/issues/51) (ranking engine), [#49](https://github.com/k22i/Staysh/issues/49) (Streams epic) · Date: 2026-10-11
Spike code: [`spikes/stream-ranking/`](../../spikes/stream-ranking/) (throwaway). Raw results: [`spikes/stream-ranking/results/`](../../spikes/stream-ranking/results/). Labels: [`spikes/stream-ranking/labels/`](../../spikes/stream-ranking/labels/).

## Verdict

**Go.** Addon responses carry enough signal to parse reliably, and a plain TypeScript parser and ranker written in-house is accurate and fast enough for story 2: pick the best stream without reading file names.

- **Parsing is solved for the fields that decide the ranking.** On 60 streams labelled only after the parser was frozen, resolution, HDR / DV, video and audio codec, channels, Atmos and debrid cache state were 100% correct. Size was 100%, source 95%, season / episode ≥ 96.7%. Release group (86.7%) and audio languages (85%) are weaker. They matter less for ranking, and both fail in ways we can fix.
- **Fake detection is precise but misses about a third.** The "hide" signals (wrong season / episode / year, extras, non-video files, impossibly small files) **hid no genuine stream** among all 360 labelled ones, and caught 24 of 38 fakes (63%). CAM / TS / screener detection was 11 / 11 with no false positives. Most misses are **wrong-title results** from fuzzy-search addons, and long-running anime whose releases number episodes differently from Kitsu. A title-match check would catch some, but only once we have localized titles. Without them it was wrong 22 times out of 26.
- **Ranking ~200 streams fits in a frame:** 5.2 ms median / 6.9 ms p95 on V8 (WebView2's engine) and 6.8 / 10.1 ms on JavaScriptCore (WKWebView, WebKitGTK), on an M1 Pro. But **Comet alone sends ~1,400 streams for a popular film**, and a whole title can reach ~2,200. Ranking that in one go takes 40–70 ms. Feeding it in 150-stream chunks keeps every step under 6 ms p95. So run the engine in a Web Worker, time-slice it, or both.
- **De-dup matters:** 35% of all streams were the same file reached through another addon or torrent (20,453 → 13,378).

**Recommendation:** build #51 as a pure TS module beside the addon client (#37), run it in a Web Worker, and feed it addon and plugin (#56) results in one `Stream` shape. Rank by cached-on-debrid, then quality, then plausible size, with weights in one table ([below](#scoring-model-and-default-weights)). Hide only on strong signals; put CAM / TS in their own collapsed group. In v1, expose preferred audio languages, a resolution cap and HDR / DV capability (auto-detected, overridable) to the user. Don't expose the weights. Adopt the [accuracy targets](#accuracy-targets-for-51) as #51's CI gate.

## How this was tested (read before trusting the numbers)

- **Corpus:** real `/stream` responses for 20 titles (8 films, 6 series episodes, 6 anime), recorded on 2026-10-11 from five addon configurations ([table](#fixture-corpus)). The titles were picked to stress different things: 4K / DV / Atmos / remux catalogues, old SD / HDTV shows, non-English and multi-audio releases, season packs, fansub naming and absolute episode numbers, and two films still in cinemas (*Spider-Man: Brand New Day*, *Coyote vs. Acme*) for CAMs and fakes. Fixtures are test data only. Debrid keys and opaque URL tokens were redacted before writing, and a check fails the recording if a key survives.
- **Labels:** one labeller (the agent that ran this spike) hand-labelled 300 streams, sampled per addon and spread across titles ([rules](../../spikes/stream-ranking/labels/README.md)), **before writing the parser**. Two-thirds were the **dev** split, used for tuning. A third were **holdout**: only aggregate numbers were looked at while tuning. Because the labeller also wrote the parser and had read every holdout string while labelling, a **blind** set of 60 more streams was drawn and labelled **after the parser and heuristics were frozen**. The blind numbers are the honest ones; the dev numbers are optimistic. Labels record what a stream *claims*: "2160p" means the release says so, not that anyone checked the video. `fake` is a judgement call, made from the text alone.
- **Samples are stratified, not proportional.** Comet makes up 70% of all streams but 30% of the labels. Accuracy per addon is in [`results/accuracy.json`](../../spikes/stream-ranking/results/accuracy.json).
- **Timings:** this Mac (M1 Pro, macOS 27.0.1), Node 26.3 (V8) and Bun 1.3.10 (JavaScriptCore), **while the machine was in use**. They aren't measured inside WebView2, WKWebView or WebKitGTK, and not on a low-end machine. Treat them as indicative.

## Fixture corpus

| Addon (config) | Titles | Streams | Median response | Notes |
|---|---:|---:|---:|---|
| Torrentio (none) | 20 | 1,659 | 325 ms | P2P. `infoHash` + `fileIdx`, text in `title` |
| TorrentsDB (none) | 20 | 1,229 | 669 ms | P2P, Torrentio-like format. `📅 SxxEyy` tag is sometimes wrong |
| Peerflix (none) | 16 | 122 | 440 ms | Spanish releases. IMDb ids only. Non-standard top-level fields |
| Torrentio + TorBox | 20 | 3,173 | 1,051 ms | Debrid. **No `infoHash`**: the hash is only in the resolve URL |
| Comet (ElfHosted) + TorBox | 20 | 14,270 | 1,172 ms (max 18 s) | Debrid only on ElfHosted. **~1,400 streams for a popular film** by default |
| *MediaFusion (ElfHosted) + TorBox* | | *0* | | *Every title returned 0 streams, both without a config and with a TorBox one. Left out, not debugged.* |

## Where the signal lives

Share of each addon's streams carrying a signal ([`results/inventory.json`](../../spikes/stream-ranking/results/inventory.json)):

| Signal | Comet + TB | Peerflix | Torrentio | Torrentio + TB | TorrentsDB |
|---|---:|---:|---:|---:|---:|
| Resolution in `name` | 72% | 87% | 88% | 87% | 89% |
| HDR / DV in `name` | 0% | 0% | 18% | 19% | 0% |
| Debrid cache marker in `name` | 100% | | | 100% | |
| Text in `title` (deprecated) / `description` | `description` | `description` | `title` | `title` | `title` |
| Release / torrent name in the text | 100% | 100% | 100% | 100% | 100% |
| Size in the text (`💾`) | 100% | 86% | 100% | 100% | 100% |
| Seeders in the text (`👤`) | 42% | 89% | 100% | 100% | 100% |
| Language flags / words | 45% | 0%¹ | 60% | 64% | 1% |
| Addon's own parsed tags (`📹 🔊 ⭐`) | 76% | | | | |
| `behaviorHints.filename` | 100% | | 94% | 93% | 100% |
| … with a video extension (a real file, not a torrent name) | 59% | | 94% | 93% | 100% |
| `behaviorHints.videoSize` | 100% | | | | |
| `behaviorHints.bingeGroup` | 100% | | 99% | 99% | 100% |
| … carrying the info hash | 100% | | 27% | 29% | 14% |
| `infoHash` / `fileIdx` | 0% / 0% | 100% / 69% | 100% / 94% | **0% / 0%** | 100% / 100% |
| Info hash recoverable somewhere (field, URL, `bingeGroup`) | 100% | 100% | 100% | 100% | 100% |

¹ Peerflix sends `language: "es"` (plus `quality`, `seed`, `sizebytes`) as top-level fields.

What this means for the parser:

- **The release name is the signal.** Every addon puts the torrent or file name in its text. The `name` field is the addon's own short parse (resolution, sometimes HDR). Comet adds its own parsed tags too. Our parser reads, most specific first: the file that plays (`behaviorHints.filename`, or the second text line in Torrentio / TorrentsDB / Peerflix), its folders, the torrent name, Comet's tags, then `name`.
- **Read both `description` and `title`.** Torrentio and TorrentsDB still send only the deprecated `title`.
- **Debrid cache state exists only as addon-specific strings in `name`:** `[TB+]` / `[TB download]` (Torrentio), `[TB⚡]` / `[TB⬇️]` (Comet). Every debrid service and addon combination needs a pattern. There's no protocol field.
- **The info hash has to be dug out:** debrid Torrentio drops `infoHash` and `fileIdx` and keeps the hash only in its resolve URL. Comet keeps it in `bingeGroup`. Both URLs embed the user's debrid credentials (Torrentio's literally), so **never log stream URLs**.
- **Packs:** Comet's "filename" is the torrent name 41% of the time (no extension), so the playing file isn't known until the stream is resolved. TorrentsDB sometimes shows the whole torrent's size next to a single-episode file name. One stream was 98.8 GB for "S01E01".
- **Don't trust addon metadata over the name.** TorrentsDB's `📅 S01E01` was attached to S02, S03 and S04 episodes, extras and a podcast. Torrentio's flags are often subtitle languages (`Multi Subs / 🇬🇧 / 🇵🇹 …`).

## Parser accuracy

Per field, against the labels ([`results/accuracy.json`](../../spikes/stream-ranking/results/accuracy.json)). The **blind** column is the one to quote.

| Field | dev (n=200) | holdout (n=100) | **blind (n=60)** | all (n=360) |
|---|---:|---:|---:|---:|
| Resolution | 100% | 100% | **100%** | 100% |
| HDR10 / HDR10+ / DV | 100% | 100% | **100%** | 100% |
| Video codec | 100% | 100% | **100%** | 100% |
| Audio codec (best track) | 100% | 100% | **100%** | 100% |
| Channels | 100% | 100% | **100%** | 100% |
| Atmos | 100% | 100% | **100%** | 100% |
| Size (±3%) | 100% | 99% | **100%** | 99.7% |
| Source (Remux, BluRay, WEB-DL, WEBRip, HDTV, DVD, CAM, TS, …) | 100% | 99% | **95%** | 98.9% |
| Release group | 96.5% | 87% | **86.7%** | 92.2% |
| Audio languages (exact set) | 99.5% | 93% | **85%** | 95.3% |
| … per language code, precision / recall | 99.7 / 100 | 93.6 / 95.2 | **79.6 / 97.4** | 94.5 / 98.2 |
| Season | 99.5% | 99% | **100%** | 99.4% |
| Episode | 100% | 99% | **96.7%** | 99.2% |
| Pack (size covers more than one video) | 96% | 97% | **95%** | 96.1% |
| Cached on debrid | 100% | 100% | **100%** | 100% |

The first version of the parser was already at ≥ 99.5% for resolution, HDR, codecs and audio on every split. Tuning on dev moved release group from 82% to 96.5% and languages from 80% to 99.5%. The holdout and blind numbers show that some of that was fit to dev.

What still fails, all fixable in #51:

- **Languages:** subtitle lists such as `[ENG][POR-BR][SPA-LA][SPA][ARA]…` (Erai-raws) read as audio languages. That was the blind set's main miss. Flags are ambiguous too (audio or subtitles). We treat them as audio unless the text says `Multi Subs`, `VOSTFR`, `Legendado`, `Subtitulado` or similar. This field also had the loosest labelling rules.
- **Release group:** site tags (`katmovie-hd.nl`, `NNMClub`), groups without a leading hyphen (`… Subs KINGDOM`, `… sub ita eng Licdom`), and double tags (`FLUX-PSOTNIK HT`).
- **Source:** releases that name no source (`[DB] … BD1080p`, Spanish `FullBluray`), and `TSScreener`.
- **Episode:** bare episode numbers glued to other tokens (`_-_01_`, `S1 - 01`).
- **Pack:** undetectable when an addon shows a single file name with the whole torrent's size (TorrentsDB).

## Fake detection

Each stream gets one verdict. `hidden` goes into a collapsed "Likely fake" group, `low quality` into a collapsed "CAM / TS" group, and `suspicious` streams stay visible but rank below clean ones ([`src/fakes.ts`](../../spikes/stream-ranking/src/fakes.ts)).

| Check | Bucket | Fired on labelled streams | Of those, actually fake / CAM |
|---|---|---:|---:|
| Wrong season (another season of the show; Kitsu ids are per season) | hidden | 10 | 10 |
| Extras (sample, trailer, featurette, deleted scenes, OST, NCOP, bonus, …) | hidden | 7 | 7 |
| Too small (< 0.2 Mbps for the runtime) | hidden | 5 | 5 |
| Wrong year (films ±1; shows: no year before the first season) | hidden | 4 | 4 |
| Wrong episode | hidden | 3 | 3 |
| Non-video file (`.zip`, `.exe`, `.rar`, …) | hidden | 1 | 1 |
| An episode (`SxxEyy`) for a film request | hidden | 1 | 1 |
| CAM / TS / TC / screener tag | low quality | 11 | 11 |
| Too large for the source (WEB-DL > 50 Mbps, remux > 140 Mbps) | suspicious | 7 | 3 |
| Title shares no word with the title or its aliases | *reported only* | 26 | 4 |

| | dev | holdout | blind | all |
|---|---|---|---|---|
| **Hidden, false-positive rate** (genuine streams hidden) | 0% (0/177) | 0% (0/92) | 0% (0/53) | **0% (0/322)** |
| **Hidden, recall** (fakes caught) | 74% (17/23) | 62.5% (5/8) | 29% (2/7) | **63% (24/38)** |
| Hidden or suspicious, false-positive rate | 1.1% | 2.2% | 0% | 1.2% |
| CAM / TS flag, recall / false-positive rate | 5/5 / 0% | 5/5 / 0% | 1/1 / 0% | **11/11 / 0%** |

Fakes cluster by addon. **17.6% of the labelled Comet streams and 21.2% of TorrentsDB's were fakes, against 2.8–4.2% for Torrentio and none for Peerflix.** Over the whole corpus, Comet had 7.7% and TorrentsDB 7.5% of streams hidden, Torrentio ~2% ([`results/corpus.json`](../../spikes/stream-ranking/results/corpus.json)). Comet's broad search returns other films (*Paris, Texas* and *The Martian* for *Dune* and *Spider-Man*), soundtracks, trailers, a law case named *Oppenheimer v. …*, and **106 non-video files, including an `.exe` named like a *Lanterns* episode**. TorrentsDB mislabels other seasons as the requested episode.

The 14 misses:

- **Long-running anime (5):** One Piece episode 1100 also returned season packs, *One Piece Film Z* and the 2023 live-action series. Without a map from Kitsu's absolute numbers to the releases' season numbers, a "S01" pack or `S22E15` (which *is* episode 1100) can't be judged. We chose not to flag them rather than hide real episodes.
- **Wrong title that shares words (4):** *Slime Parasite*, *Spider-Man 2*, *Hunter x Hunter* and *Family Guy* (the last two have no word in common with the request, so the title check caught them, but it isn't trusted yet).
- **Spin-offs and OADs (2):** *Attack on Titan: Junior High* episode 1, an OAD episode 1.
- **One each:** an audiobook upload (named only after the book), 14 episodes in 116 MB (a pack, so its size isn't judged), and a TorrentsDB `S02E014` the Kitsu rule doesn't cover.

**Title matching is the next lever, but only with localized titles.** Matching release names against Cinemeta's English title was wrong 22 times out of 26, because releases use *Cadena perpetua*, *Les évadés*, *Linternas*, *Kimi no Na wa*. Kitsu's aliases helped for anime. #51 should take alternative and translated titles from the metadata source (TMDB) before turning this check on, and then start it as `suspicious`, not `hidden`.

## Scoring model and default weights

The order from #51: **cached on debrid, then quality, then a plausible size.** Each band is wide enough that a lower band can't overturn a higher one. Weights live in one table, [`defaultWeights`](../../spikes/stream-ranking/src/rank.ts):

| Term | Weight |
|---|---|
| Cached on the user's debrid | +10,000 |
| P2P seeders | +150 per ×10 seeders; 0 seeders −2,000 |
| Resolution | 2160p 4,000 · 1440p 3,500 · 1080p 3,000 · 720p 2,000 · 576p 1,200 · 480p 1,000 · 360p 500 · unknown 1,500 |
| Above the user's / display's resolution cap | −6,000 |
| Source | Remux 600 · BluRay 500 · WEB-DL 450 · WEBRip 350 · HDTV 200 · DVD 150 · other 100 · unknown 250 |
| HDR the display can show | DV 300 · HDR10+ 250 · HDR10 200 |
| DV with no HDR10 fallback on a non-DV display | −800 (wrong colours) |
| Audio | TrueHD / DTS:X 120 · DTS-HD 100 · LPCM 100 · FLAC 80 · E-AC3 60 · DTS 50 · AC3 40 · Opus 30 · AAC 20 · unknown 20; Atmos +40 |
| Video codec | HEVC / AV1 40 · AVC 20 · MPEG-2 −50 · XviD −150 |
| Size | log2(bitrate ÷ expected for the resolution) × 60, clamped to −400…+120. Expected: 2160p 8 Mbps, 1080p 3, 720p 1.5, SD 0.8–1 |
| Preferred audio language present | +1,500 (÷ rank in the preference list) |
| Languages stated and none preferred (and not MULTi) | −2,500 |
| Suspicious | −3,000 |

So a cached 720p beats an uncached 4K remux. A French-only 4K ranks below an English 1080p for an English speaker, but a release that states no language is never penalized. Ties fall back to arrival order, so the list doesn't reshuffle at random as addons answer.

**Groups:** 4K · 1080p (incl. 1440p) · 720p · SD · Unknown · Low quality (collapsed) · Likely fake (collapsed). The top pick is the best stream outside the two collapsed groups. Once the user starts navigating, `pinTop()` keeps it put even if a better stream arrives later (#51).

## De-duplication

Two streams are one if they share **info hash + file** (the file name when known, else `fileIdx`, else the bare hash), or failing that, the **same file name with a size within 1%** (the same file in a different torrent). When merging, we keep the copy that plays soonest (cached debrid, then uncached debrid, then P2P, then the higher score). The rest become `alternates`, ready as fallbacks if the first fails to resolve.

Across the corpus that removed **35% of streams** (20,453 → 13,378). By title it ranged from 5% (One Piece episode 1100, mostly one addon) to 60% (*Severance*, *Lanterns*), and about a third of the merges matched by file name and size rather than by hash. Torrentio and Comet both return many of the same cached torrents, so without de-dup the debrid half of the list would show most entries twice.

## Timings

M1 Pro, machine in use ([`results/bench-node.json`](../../spikes/stream-ranking/results/bench-node.json), [`results/bench-bun.json`](../../spikes/stream-ranking/results/bench-bun.json)). Each run covers parse + judge + score + de-dup + group, and building the grouped view.

| | V8 (Node 26) | JavaScriptCore (Bun 1.3) |
|---|---|---|
| Parse, per stream | 15 µs | 21 µs |
| **~200 streams, at once** (first 200 per title as they arrive), median / p95 / max | **5.2 / 6.9 / 8.5 ms** | **6.8 / 10.1 / 25 ms** |
| … cold (first call in the process, before the JIT warms up) | 29 ms | 26 ms |
| All addons for one title (1,300–2,200 streams), median | 27–49 ms | 37–66 ms |
| Incremental: one addon's answer arriving, median / p95 / max | 2.3 / 23 / 65 ms | 2.9 / 33 / 45 ms |
| Rebuilding everything at that point instead, median / p95 | 6.4 / 35 ms | 8.6 / 45 ms |
| **Fed in 150-stream chunks** (biggest titles), median / p95 / max | **2.9 / 4.3 / 8.9 ms** | **3.9 / 5.8 / 14 ms** |

- **The ≤ 16 ms target for ~200 streams holds** at p95 on both engines (JSC's max of 25 ms is probably a GC pause). The very first call takes 26–29 ms while the JIT warms up, so warm the worker up when a title page opens.
- **Parsing is the cost**, not sorting. The worst single steps were always Comet's 1,000–1,500-stream answers (35–65 ms). Incremental merging is ~3× cheaper than re-sorting everything, but it doesn't help with one big batch.
- **So:** run the engine in a **Web Worker** (it's pure functions over plain data, so it moves without changes) and **feed it in ~150-stream slices**. Each slice then stays within a few ms, wherever it runs. Also ask Comet for fewer results (its config has per-resolution limits), which saves the network and parse work too.

## Accuracy targets for #51

Measured over all 360 labelled streams, set a little below what this spike reached, so that a regression fails CI but label noise doesn't. They're in [`src/targets.ts`](../../spikes/stream-ranking/src/targets.ts) and enforced by [`test/accuracy.test.ts`](../../spikes/stream-ranking/test/accuracy.test.ts).

| Field | Target | | Fakes / CAM / speed | Target |
|---|---:|---|---|---:|
| Resolution | ≥ 98% | | Hidden, false-positive rate | ≤ 1% |
| HDR / DV | ≥ 97% | | Hidden, recall | ≥ 60% (raise as title matching lands) |
| Video codec | ≥ 97% | | CAM / TS recall | ≥ 95% |
| Audio codec, channels | ≥ 95% | | CAM / TS false-positive rate | ≤ 1% |
| Atmos | ≥ 98% | | ~200 streams, p95 | ≤ 16 ms (reference machine, V8 and JSC) |
| Size | ≥ 98% | | | |
| Source | ≥ 93% | | | |
| Release group | ≥ 85% | | | |
| Languages (exact set) | ≥ 80% | | | |
| Season / episode | ≥ 97% / ≥ 95% | | | |
| Pack | ≥ 90% | | | |
| Cached on debrid | 100% | | | |

**Keep growing the labelled set** as #51 fixes things, especially wrong-title fakes, debrid services other than TorBox, and addons we haven't recorded. Make every new label blind to the parser change it tests.

## Where the engine lives, and what users see

- **A frontend TS module beside the addon client (#37), running in a Web Worker.** It needs nothing from Go. The addon client already has the `Stream` objects, and the result is pure UI state. Plugin results (#56) come from Go's goja runtime. They should arrive as the same `Stream` shape, tagged with their source, and go through the same `add()`. Next-episode auto-pick (#58) and the in-player switcher (#68) read the same engine.
- **User-facing in v1:** preferred audio languages (an ordered list), a maximum resolution, and HDR / Dolby Vision capability. The last two should be detected from the display and stay overridable. A "show CAM / TS" choice is just the collapsed group. Fakes are hidden but can always be expanded.
- **Not user-facing:** the weights. They're one table we can tune from telemetry and bug reports.

## TS interface for #49

The contract the Streams epic can build on. It's what the spike implements ([`parse.ts`](../../spikes/stream-ranking/src/parse.ts), [`fakes.ts`](../../spikes/stream-ranking/src/fakes.ts), [`rank.ts`](../../spikes/stream-ranking/src/rank.ts), [`engine.ts`](../../spikes/stream-ranking/src/engine.ts)), trimmed:

```ts
// Input: what /meta gave us, and the user's / device's preferences.
type TitleContext = {
  type: 'movie' | 'series'; kind: 'movie' | 'series' | 'anime'; id: string;
  name: string; aliases?: string[]; year?: number; runtimeMin?: number;
  season?: number; episode?: number;
};
type Prefs = { languages: string[]; maxResolution: Resolution; hdr: boolean; dolbyVision: boolean; debrid: boolean };

// One stream, parsed. Every field is null / [] when the stream doesn't say.
type Parsed = {
  resolution: Resolution | null; hdr: ('DV' | 'HDR10+' | 'HDR10')[];
  videoCodec: VideoCodec | null; audioCodec: AudioCodec | null; channels: Channels | null; atmos: boolean;
  sizeBytes: number | null; source: Source | null; group: string | null; languages: string[];
  season: number | null; episode: number | null; pack: boolean; year: number | null;
  cached: boolean | null; debrid: string | null; infoHash: string | null; fileIdx: number | null;
  fileName: string | null; releaseNames: string[]; extension: string | null; seeders: number | null; extras: boolean;
};
type Verdict = { bucket: 'ok' | 'suspicious' | 'low quality' | 'hidden'; reasons: Reason[] };

type Candidate = {
  key: string; addon: string; stream: Stream; parsed: Parsed; verdict: Verdict;
  score: number; tier: Tier; alternates: { addon: string; stream: Stream }[];
};
type Tier = '4K' | '1080p' | '720p' | 'SD' | 'Unknown' | 'Low quality' | 'Likely fake';

class StreamEngine {
  constructor(ctx: TitleContext, prefs?: Prefs, weights?: Weights);
  add(source: string, streams: Stream[]): number;   // one addon / plugin answered (or one slice of it)
  view(): { top: Candidate | null; groups: { tier: Tier; items: Candidate[] }[]; total: number };
  pinTop(): void;                                     // the user started navigating: keep the highlight
}
```

`parseStream(stream, hints)`, `judge(parsed, ctx)` and `scoreStream(parsed, verdict, ctx, prefs, weights)` stay exported on their own for tests and for the player's switcher.

## Gotchas (what #51 must handle)

1. **Comet sends ~1,400 streams per popular title** by default, and up to 18 s late. Parse in slices, off the UI thread, and render the list as it fills.
2. **Debrid Torrentio has no `infoHash`/`fileIdx`.** Take the hash from the resolve URL (`/resolve/<service>/<key>/<hash>/…`). Comet's is in `bingeGroup`.
3. **Stream URLs carry the user's debrid key** (Torrentio puts it in the path). Never log them, and redact them in bug reports.
4. **Cache markers are free text per addon** (`[TB+]`, `[TB download]`, `[TB⚡]`, `[TB⬇️]`). Each debrid service and addon combination needs a pattern and a fixture. This spike only saw TorBox.
5. **`title` is deprecated, but two of the five addons send nothing else.**
6. **Addon tags lie:** TorrentsDB's `📅 S01E01`, Torrentio's flags (often subtitles), Peerflix's `quality` (claimed 1080p for an XviD AVI). Prefer the release name, and use addon tags only as a fallback.
7. **Anime numbering:** Kitsu ids are per season with episodes from 1, except long runners (One Piece) that count absolutely. Releases use either. Wrong-season checks only work for the first kind. Long runners need an episode map.
8. **Sizes can be the whole torrent's.** Don't judge plausibility on packs, and expect a few single-episode streams with pack sizes (TorrentsDB).
9. **Localized titles are normal** (Spanish, French, Russian, Chinese, Czech releases). Any title check needs translated titles first.

## Open risks / not covered

- **One labeller, small fake sample.** 38 labelled fakes, and the person who labelled them also wrote the parser. Only the blind set (60 streams, 7 fakes) is independent of the tuning. Fake recall in particular has a wide error bar.
- **Popular titles only, mostly English and well-seeded.** Obscure titles, non-English catalogues (except Peerflix's Spanish) and kids' content weren't covered.
- **One debrid service (TorBox).** Real-Debrid, AllDebrid and Premiumize markers weren't recorded; #49 launches with TorBox, AllDebrid and Premiumize. **MediaFusion** (0 streams with our config) and AIOStreams, StremThru and Jackettio (all need configuration) aren't in the corpus.
- **Timings are from a fast Mac outside a webview.** Low-end Windows laptops and real WebView2 / WKWebView / WebKitGTK workers are unmeasured. The 3–4× headroom at 200 streams and the chunking result suggest it'll fit, but #51 should re-measure in the app.
- **Plugin results (#56)** weren't available, so we don't know how much signal they carry. If they're thinner (no file name, no size), they'll rank in "Unknown".
- **Weights are hand-set**, checked only by eye on a few titles (top picks in the spike looked right). There's no user-preference data behind them yet.

## Reproduce

See [`spikes/stream-ranking/README.md`](../../spikes/stream-ranking/README.md). In short, from `spikes/stream-ranking/`: `npm test`, `node src/eval.ts`, `node src/report.ts`, `node src/bench.ts` and `bun src/bench.ts`. Re-recording (`node src/record.ts`) needs a TorBox key in `.env` and hits public addons.
