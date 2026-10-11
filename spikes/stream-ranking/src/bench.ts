// Timings for parse + judge + score + de-dup + group.
//
//   node src/bench.ts    # V8 (what WebView2 runs on Windows)
//   bun src/bench.ts     # JavaScriptCore (what WKWebView / WebKitGTK run on macOS / Linux)
//
// Writes results/bench-<engine>.json.
import { writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { join } from 'node:path';
import { loadFixtures, loadTitles, root } from './corpus.ts';
import { StreamEngine } from './engine.ts';
import { parseStream } from './parse.ts';
import { defaultPrefs, type Prefs } from './rank.ts';
import type { Fixture, Stream } from './types.ts';

const engine = (globalThis as { Bun?: unknown }).Bun ? `bun ${process.versions.bun} (JavaScriptCore)` : `node ${process.versions.node} (V8)`;
const prefs: Prefs = { ...defaultPrefs, languages: ['en'], hdr: true, debrid: true };
const titles = loadTitles();
const fixtures = loadFixtures();
const byTitle = new Map<string, Fixture[]>();
for (const f of fixtures) byTitle.set(f.title, [...(byTitle.get(f.title) ?? []), f].sort((a, b) => a.ms - b.ms));

const stats = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p: number) => s[Math.min(s.length - 1, Math.floor(p * s.length))];
  return { median: +q(0.5).toFixed(3), p95: +q(0.95).toFixed(3), max: +s[s.length - 1].toFixed(3) };
};

// The first 200 streams in arrival order across addons for a title.
function first200(slug: string): { addon: string; streams: Stream[] }[] {
  let left = 200;
  const out: { addon: string; streams: Stream[] }[] = [];
  for (const f of byTitle.get(slug)!) {
    if (left <= 0) break;
    out.push({ addon: f.addon, streams: f.streams.slice(0, left) });
    left -= Math.min(left, f.streams.length);
  }
  return out;
}

function rankOnce(slug: string, batches: { addon: string; streams: Stream[] }[]) {
  const e = new StreamEngine(titles.get(slug)!, prefs);
  for (const b of batches) e.add(b.addon, b.streams);
  return e.view();
}

const results: Record<string, unknown> = { engine, cpu: cpus()[0]?.model, at: new Date().toISOString() };

// Cold: the very first rank in this process, before the JIT has seen the code.
{
  const t = performance.now();
  rankOnce('dune-part-two', first200('dune-part-two'));
  results.cold200ms = +(performance.now() - t).toFixed(3);
}

// Parse only, per stream.
{
  const all = fixtures.flatMap((f) => f.streams);
  for (let i = 0; i < 2; i++) for (const s of all) parseStream(s, { type: 'movie' });
  const t = performance.now();
  for (const s of all) parseStream(s, { type: 'movie' });
  results.parseUsPerStream = +(((performance.now() - t) * 1000) / all.length).toFixed(2);
}

// ~200 streams, all at once, warm.
{
  const times: number[] = [];
  for (let round = 0; round < 30; round++) {
    for (const slug of titles.keys()) {
      const batches = first200(slug);
      const t = performance.now();
      rankOnce(slug, batches);
      if (round >= 5) times.push(performance.now() - t);
    }
  }
  results.rank200ms = stats(times);
}

// Everything every addon returned for a title (up to ~2,200 streams), all at once, warm.
{
  const per: Record<string, unknown> = {};
  for (const slug of ['dune-part-two', 'oppenheimer', 'shawshank', 'one-piece-e1100']) {
    const batches = byTitle.get(slug)!.map((f) => ({ addon: f.addon, streams: f.streams }));
    const n = batches.reduce((a, b) => a + b.streams.length, 0);
    const times: number[] = [];
    for (let i = 0; i < 25; i++) {
      const t = performance.now();
      rankOnce(slug, batches);
      if (i >= 5) times.push(performance.now() - t);
    }
    per[slug] = { streams: n, ...stats(times) };
  }
  results.rankAllAddonsMs = per;
}

// Incremental: addons answer one by one in their recorded response order. Cost of each
// add() + view(), against rebuilding the whole ranking from scratch at that point.
{
  const perAdd: number[] = [];
  const perRebuild: number[] = [];
  const worst: Record<string, unknown> = {};
  for (let round = 0; round < 10; round++) {
    for (const [slug, fs] of byTitle) {
      const e = new StreamEngine(titles.get(slug)!, prefs);
      fs.forEach((f, i) => {
        let t = performance.now();
        e.add(f.addon, f.streams);
        e.view();
        const add = performance.now() - t;
        t = performance.now();
        rankOnce(slug, fs.slice(0, i + 1).map((x) => ({ addon: x.addon, streams: x.streams })));
        const rebuild = performance.now() - t;
        if (round >= 2) {
          perAdd.push(add);
          perRebuild.push(rebuild);
          const w = worst[slug] as { add: number } | undefined;
          if (!w || add > w.add) worst[slug] = { add: +add.toFixed(3), addon: f.addon, streams: f.streams.length };
        }
      });
    }
  }
  results.incrementalAddMs = stats(perAdd);
  results.fullRebuildMs = stats(perRebuild);
  results.worstAddPerTitle = worst;
}

// Time-sliced: the biggest titles fed in chunks of 150 streams (one chunk per frame, or per
// idle callback), so no single step blocks for long even when Comet sends ~1,400 at once.
{
  const times: number[] = [];
  for (let round = 0; round < 12; round++) {
    for (const slug of ['dune-part-two', 'oppenheimer', 'shawshank', 'your-name']) {
      const e = new StreamEngine(titles.get(slug)!, prefs);
      for (const f of byTitle.get(slug)!) {
        for (let i = 0; i < f.streams.length; i += 150) {
          const t = performance.now();
          e.add(f.addon, f.streams.slice(i, i + 150));
          e.view();
          if (round >= 2) times.push(performance.now() - t);
        }
      }
    }
  }
  results.chunk150Ms = stats(times);
}

const name = engine.startsWith('bun') ? 'bun' : 'node';
writeFileSync(join(root, 'results', `bench-${name}.json`), JSON.stringify(results, null, 2) + '\n');
console.log(JSON.stringify(results, null, 2));
