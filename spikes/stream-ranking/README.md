# Spike: our own stream parser and ranker

Throwaway code for [#6](https://github.com/k22i/Sinag/issues/6). The findings are in
[`docs/spikes/stream-ranking.md`](../../docs/spikes/stream-ranking.md). Build #51 from the findings, not from this code.

Pure TypeScript with no dependencies. It runs on Node ≥ 24 with no build step (Node strips the types), and under Bun for the JavaScriptCore timings.

| | |
|---|---|
| [`src/parse.ts`](src/parse.ts) | Parser: one addon stream → resolution, HDR, codecs, audio, size, source, group, languages, season / episode, pack, cache state, hash |
| [`src/fakes.ts`](src/fakes.ts) | Fake and low-quality heuristics → `ok` / `suspicious` / `low quality` / `hidden` |
| [`src/rank.ts`](src/rank.ts) | Scoring (all weights in `defaultWeights`), quality tiers, de-dup keys |
| [`src/engine.ts`](src/engine.ts) | `StreamEngine`: incremental add per addon, ranked groups, pinned top pick |
| [`src/record.ts`](src/record.ts), [`src/redact.ts`](src/redact.ts), [`src/titles.ts`](src/titles.ts) | Records the fixture corpus, redacting keys and opaque tokens |
| [`src/inventory.ts`](src/inventory.ts) | Where the signal lives per addon → `results/inventory.json` |
| [`src/sample.ts`](src/sample.ts), [`labels/`](labels/) | Labelling sample and hand labels ([rules](labels/README.md)) |
| [`src/eval.ts`](src/eval.ts) | Per-field accuracy and fake error rates → `results/accuracy.json` |
| [`src/report.ts`](src/report.ts) | Whole-corpus de-dup and verdict rates → `results/corpus.json` |
| [`src/bench.ts`](src/bench.ts) | Timings → `results/bench-{node,bun}.json` |
| [`src/targets.ts`](src/targets.ts), [`test/`](test/) | Accuracy targets proposed for #51 and the tests that enforce them |

## Commands

```sh
npm test                 # node --test: accuracy gate + engine / parser / redaction tests
node src/eval.ts         # accuracy tables (--failures lists dev-split misses)
node src/report.ts       # de-dup and verdict rates over all 20k streams
node src/bench.ts        # V8 timings
bun src/bench.ts         # JavaScriptCore timings
node src/inventory.ts    # signal inventory
node src/record.ts       # re-record fixtures (hits public addons; see below)
```

## Fixtures

`fixtures/<addon>/<title>.json` are real `/stream` responses recorded on 2026-10-11 from Torrentio, TorrentsDB and Peerflix (no config) and from Torrentio and Comet (ElfHosted) with a TorBox key. `fixtures/titles.json` holds what `/meta` would give the app (name, year, runtime, Kitsu aliases).

Re-recording needs `TORBOX_API_KEY` in `spikes/stream-ranking/.env` (git-ignored) for the debrid configs. Before a fixture is written, the key, the config path segment and opaque URL tokens are redacted, and the file is checked for leftovers ([`src/redact.ts`](src/redact.ts)). Fixtures are test data only: no content links go into docs.
