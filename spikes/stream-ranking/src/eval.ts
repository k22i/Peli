// Per-field parser accuracy against the hand labels, per split and per addon.
//
//   node src/eval.ts               # summary, writes results/accuracy.json
//   node src/eval.ts --failures    # also lists dev-split mismatches (never holdout ones)
//   node src/eval.ts --blind-failures  # blind-split mismatches, for the write-up only (no tuning)
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './corpus.ts';
import { loadLabelled, type Label, type LabelledStream } from './labels.ts';
import { judge } from './fakes.ts';
import { parseStream, type Parsed } from './parse.ts';

type Field = { name: string; got: (p: Parsed) => unknown; want: (l: Label) => unknown; eq?: (got: unknown, want: unknown) => boolean };

const alt = (got: unknown, want: unknown) => (Array.isArray(want) ? want.includes(got) : got === want);
const ci = (got: unknown, want: unknown) => {
  const g = typeof got === 'string' ? got.toLowerCase() : got;
  const ws = (Array.isArray(want) ? want : [want]).map((w) => (typeof w === 'string' ? w.toLowerCase() : w));
  return ws.includes(g);
};
const sameSet = (got: unknown, want: unknown) => {
  const a = [...((got as string[]) ?? [])].sort();
  const b = [...((want as string[]) ?? [])].sort();
  return a.length === b.length && a.every((x, i) => x === b[i]);
};
const nearSize = (got: unknown, want: unknown) => {
  if (want === null || want === undefined) return got === null;
  if (typeof got !== 'number') return false;
  const gb = got / 2 ** 30;
  return Math.abs(gb - (want as number)) <= Math.max(0.03 * (want as number), 0.01);
};

export const fields: Field[] = [
  { name: 'resolution', got: (p) => p.resolution, want: (l) => l.res ?? null, eq: alt },
  { name: 'hdr', got: (p) => p.hdr, want: (l) => l.hdr ?? [], eq: sameSet },
  { name: 'video codec', got: (p) => p.videoCodec, want: (l) => l.vcodec ?? null, eq: alt },
  { name: 'audio codec', got: (p) => p.audioCodec, want: (l) => l.audio ?? null, eq: alt },
  { name: 'channels', got: (p) => p.channels, want: (l) => l.ch ?? null, eq: alt },
  { name: 'atmos', got: (p) => p.atmos, want: (l) => l.atmos ?? false },
  { name: 'size', got: (p) => p.sizeBytes, want: (l) => l.sizeGB ?? null, eq: nearSize },
  { name: 'source', got: (p) => p.source, want: (l) => l.source ?? null, eq: alt },
  { name: 'release group', got: (p) => p.group, want: (l) => l.group ?? null, eq: ci },
  { name: 'languages', got: (p) => p.languages, want: (l) => l.langs ?? [], eq: sameSet },
  { name: 'season', got: (p) => p.season, want: (l) => l.season ?? null },
  { name: 'episode', got: (p) => p.episode, want: (l) => l.episode ?? null },
  { name: 'pack', got: (p) => p.pack, want: (l) => l.pack ?? false },
  { name: 'cached', got: (p) => p.cached, want: (l) => l.cached ?? null },
];

export function parseLabelled(s: LabelledStream): Parsed {
  return parseStream(s.stream, { type: s.ctx.type, anime: s.ctx.kind === 'anime' });
}

export function score(rows: LabelledStream[], field: Field) {
  const eq = field.eq ?? ((a, b) => a === b);
  let ok = 0;
  const misses: { id: string; got: unknown; want: unknown }[] = [];
  for (const r of rows) {
    const got = field.got(parseLabelled(r));
    const want = field.want(r.label);
    if (eq(got, want)) ok++;
    else misses.push({ id: r.id, got, want });
  }
  return { ok, n: rows.length, pct: Math.round((1000 * ok) / rows.length) / 10, misses };
}

// Precision / recall of individual language codes, which is fairer than exact-set match.
function languagePR(rows: LabelledStream[]) {
  let tp = 0, fp = 0, fn = 0;
  for (const r of rows) {
    const got = new Set(parseLabelled(r).languages);
    const want = new Set(r.label.langs ?? []);
    for (const g of got) (want.has(g) ? tp++ : fp++);
    for (const w of want) if (!got.has(w)) fn++;
  }
  return { precision: Math.round((1000 * tp) / (tp + fp)) / 10, recall: Math.round((1000 * tp) / (tp + fn)) / 10 };
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const all = loadLabelled();
  const dev = all.filter((r) => r.split === 'dev');
  const holdout = all.filter((r) => r.split === 'holdout');
  const blind = all.filter((r) => r.split === 'blind');
  const splits = [['dev', dev], ['holdout', holdout], ['blind', blind], ['all', all]] as const;
  const showFailures = process.argv.includes('--failures') ? dev : process.argv.includes('--blind-failures') ? blind : [];
  const addons = [...new Set(all.map((r) => r.addon))];
  const out: Record<string, unknown> = { streams: Object.fromEntries(splits.map(([s, rows]) => [s, rows.length])), fields: {} };

  console.log(`| Field | ${splits.map(([s, rows]) => `${s} (n=${rows.length})`).join(' | ')} | ${addons.join(' | ')} |`);
  console.log(`|---|${splits.map(() => '---:').join('|')}|${addons.map(() => '---:').join('|')}|`);
  for (const f of fields) {
    const per = Object.fromEntries(addons.map((ad) => [ad, score(all.filter((r) => r.addon === ad), f).pct]));
    const bySplit = Object.fromEntries(splits.map(([s, rows]) => [s, score(rows, f).pct]));
    (out.fields as Record<string, unknown>)[f.name] = { ...bySplit, byAddon: per };
    console.log(`| ${f.name} | ${splits.map(([s]) => `${bySplit[s]}%`).join(' | ')} | ${addons.map((ad) => `${per[ad]}%`).join(' | ')} |`);
    for (const m of score(showFailures, f).misses) console.log(`    ${f.name}: ${m.id} got=${JSON.stringify(m.got)} want=${JSON.stringify(m.want)}`);
  }
  out.languageCodes = Object.fromEntries(splits.map(([s, rows]) => [s, languagePR(rows)]));
  console.log('language codes (precision / recall):', JSON.stringify(out.languageCodes));

  // --- Fake / low-quality detection --------------------------------------------------------
  const lowQ = (l: Label) => ['cam', 'ts', 'tc', 'scr'].includes(String(l.source));
  const rates = (rows: LabelledStream[], flagged: (r: LabelledStream) => boolean, positive: (l: Label) => boolean) => {
    let tp = 0, fp = 0, fn = 0, tn = 0;
    for (const r of rows) {
      const f = flagged(r), pos = positive(r.label);
      if (f && pos) tp++;
      else if (f) fp++;
      else if (pos) fn++;
      else tn++;
    }
    const pct = (a: number, b: number) => (b ? Math.round((1000 * a) / b) / 10 : null);
    return { tp, fp, fn, tn, falsePositiveRate: pct(fp, fp + tn), falseNegativeRate: pct(fn, fn + tp), precision: pct(tp, tp + fp) };
  };
  const verdict = (r: LabelledStream) => judge(parseLabelled(r), r.ctx);
  const checks = {
    'hidden (strong signals) vs fake': [(r: LabelledStream) => verdict(r).bucket === 'hidden', (l: Label) => !!l.fake],
    'hidden or suspicious vs fake': [(r: LabelledStream) => ['hidden', 'suspicious'].includes(verdict(r).bucket), (l: Label) => !!l.fake],
    'cam / ts flag vs CAM / TS / TC / SCR source': [(r: LabelledStream) => verdict(r).reasons.includes('cam / ts'), lowQ],
  } as const;
  out.fakes = {};
  console.log('\n| Check | split | TP | FP | FN | TN | FP rate | FN rate |');
  console.log('|---|---|---:|---:|---:|---:|---:|---:|');
  for (const [name, [flag, pos]] of Object.entries(checks)) {
    const res: Record<string, unknown> = {};
    for (const [split, rows] of splits) {
      const x = rates(rows, flag, pos);
      res[split] = x;
      console.log(`| ${name} | ${split} | ${x.tp} | ${x.fp} | ${x.fn} | ${x.tn} | ${x.falsePositiveRate}% | ${x.falseNegativeRate}% |`);
    }
    (out.fakes as Record<string, unknown>)[name] = res;
  }
  // Per reason: how often it fires on the labelled set, and how often it's right.
  const reasons: Record<string, { fired: number; onFake: number }> = {};
  for (const r of all) {
    for (const reason of verdict(r).reasons) {
      reasons[reason] ??= { fired: 0, onFake: 0 };
      reasons[reason].fired++;
      if (r.label.fake || (reason === 'cam / ts' && lowQ(r.label))) reasons[reason].onFake++;
    }
  }
  out.reasons = reasons;
  console.log('reasons (fired / correct):', JSON.stringify(reasons));
  for (const r of showFailures) {
    const v = verdict(r);
    const hidden = v.bucket === 'hidden' || v.bucket === 'suspicious';
    if (hidden !== !!r.label.fake) console.log(`    fake: ${r.id} bucket=${v.bucket} reasons=${v.reasons.join(',')} label=${!!r.label.fake} ${r.label.note ?? ''}`);
  }
  writeFileSync(join(root, 'results', 'accuracy.json'), JSON.stringify(out, null, 2) + '\n');
}
