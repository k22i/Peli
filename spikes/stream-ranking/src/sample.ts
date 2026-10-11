// Draws the labelling sample: 300 streams, a fixed quota per addon, spread round-robin across
// titles, seeded so it is reproducible. Every third stream goes to the holdout split, which the
// parser is not tuned against. Writes labels/sample.jsonl (the text a labeller reads).
//
//   node src/sample.ts         # the 300-stream sample
//   node src/sample.ts blind   # 60 more, drawn after the parser was frozen, excluding the above
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCorpus, root, type CorpusStream } from './corpus.ts';

const blind = process.argv[2] === 'blind';
const quota: Record<string, number> = blind
  ? { 'comet-tb': 18, torrentio: 12, 'torrentio-tb': 12, torrentsdb: 11, peerflix: 7 }
  : { 'comet-tb': 90, torrentio: 60, 'torrentio-tb': 60, torrentsdb: 55, peerflix: 35 };
const taken = new Set<string>();
if (blind && existsSync(join(root, 'labels', 'sample.jsonl'))) {
  for (const l of readFileSync(join(root, 'labels', 'sample.jsonl'), 'utf8').split('\n').filter(Boolean)) taken.add(JSON.parse(l).id);
}

// mulberry32
function rng(seed: number) {
  return () => {
    seed |= 0;
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(blind ? 1949 : 6);

const corpus = loadCorpus().filter((c) => !taken.has(c.id));
const picked: CorpusStream[] = [];
for (const [addon, n] of Object.entries(quota)) {
  const byTitle = new Map<string, CorpusStream[]>();
  for (const c of corpus.filter((c) => c.addon === addon)) {
    if (!byTitle.has(c.title)) byTitle.set(c.title, []);
    byTitle.get(c.title)!.push(c);
  }
  // Shuffle each title's streams, then take one per title in turn.
  for (const list of byTitle.values()) {
    for (let i = list.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [list[i], list[j]] = [list[j], list[i]];
    }
  }
  const lists = [...byTitle.values()];
  let taken = 0;
  for (let round = 0; taken < n; round++) {
    let any = false;
    for (const list of lists) {
      if (taken < n && list[round]) {
        picked.push(list[round]);
        taken++;
        any = true;
      }
    }
    if (!any) break;
  }
}

const lines = picked.map((c, i) => {
  const { name, title, description, behaviorHints: bh, url, infoHash, sources, ...rest } = c.stream;
  void url;
  void infoHash;
  void sources;
  const extra = Object.fromEntries(Object.entries(rest).filter(([k]) => k !== 'fileIdx'));
  return JSON.stringify({
    id: c.id,
    split: blind ? 'blind' : i % 3 === 2 ? 'holdout' : 'dev',
    name,
    text: description ?? title,
    filename: bh?.filename,
    videoSize: bh?.videoSize,
    ...(Object.keys(extra).length ? { extra } : {}),
  });
});
writeFileSync(join(root, 'labels', blind ? 'blind-sample.jsonl' : 'sample.jsonl'), lines.join('\n') + '\n');
console.log(`${lines.length} streams sampled`);
