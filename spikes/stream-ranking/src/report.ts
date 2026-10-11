// Whole-corpus numbers (unlabelled): de-duplication per title and how often each verdict and
// reason fires per addon. Writes results/corpus.json.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadFixtures, loadTitles, root } from './corpus.ts';
import { StreamEngine } from './engine.ts';
import { makeCandidate, defaultPrefs } from './rank.ts';

const titles = loadTitles();
const fixtures = loadFixtures();

const dedup: Record<string, { streams: number; unique: number; sameTorrent: number; sameFile: number }> = {};
for (const [slug, ctx] of titles) {
  const e = new StreamEngine(ctx, { ...defaultPrefs, debrid: true });
  let streams = 0;
  for (const f of fixtures.filter((f) => f.title === slug).sort((a, b) => a.ms - b.ms)) {
    e.add(f.addon, f.streams);
    streams += f.streams.length;
  }
  dedup[slug] = { streams, unique: e.view().total, ...e.merges };
}

const perAddon: Record<string, { streams: number; buckets: Record<string, number>; reasons: Record<string, number> }> = {};
for (const f of fixtures) {
  const a = (perAddon[f.addon] ??= { streams: 0, buckets: {}, reasons: {} });
  f.streams.forEach((s, i) => {
    const c = makeCandidate(f.addon, s, titles.get(f.title)!, defaultPrefs, i);
    a.streams++;
    a.buckets[c.verdict.bucket] = (a.buckets[c.verdict.bucket] ?? 0) + 1;
    for (const r of c.verdict.reasons) a.reasons[r] = (a.reasons[r] ?? 0) + 1;
  });
}

const total = Object.values(dedup).reduce((t, d) => ({ streams: t.streams + d.streams, unique: t.unique + d.unique }), { streams: 0, unique: 0 });
writeFileSync(join(root, 'results', 'corpus.json'), JSON.stringify({ dedup, total, perAddon }, null, 2) + '\n');

console.log(`de-dup: ${total.streams} streams -> ${total.unique} unique (${Math.round((100 * (total.streams - total.unique)) / total.streams)}% duplicates)`);
console.log('| Title | streams | unique | same torrent | same file |\n|---|---:|---:|---:|---:|');
for (const [slug, d] of Object.entries(dedup)) console.log(`| ${slug} | ${d.streams} | ${d.unique} | ${d.sameTorrent} | ${d.sameFile} |`);
console.log('\n| Addon | streams | ok | suspicious | low quality | hidden |\n|---|---:|---:|---:|---:|---:|');
const pct = (n = 0, d: number) => `${((100 * n) / d).toFixed(1)}%`;
for (const [addon, a] of Object.entries(perAddon)) {
  console.log(`| ${addon} | ${a.streams} | ${pct(a.buckets.ok, a.streams)} | ${pct(a.buckets.suspicious, a.streams)} | ${pct(a.buckets['low quality'], a.streams)} | ${pct(a.buckets.hidden, a.streams)} |`);
}
console.log('\nreasons per addon:', JSON.stringify(Object.fromEntries(Object.entries(perAddon).map(([k, v]) => [k, v.reasons]))));
