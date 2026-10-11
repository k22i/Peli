// The engine the Streams epic (#49) would build on: feed it each addon's (or plugin's) answer
// as it arrives, read back the ranked groups. Re-ranking is incremental: new streams are
// parsed and sorted on their own, then merged into the already-sorted list.
import { better, compare, defaultPrefs, defaultWeights, fileKey, makeCandidate, tierOrder, type Candidate, type Prefs, type Tier, type Weights } from './rank.ts';
import type { Stream, TitleContext } from './types.ts';

export type RankedView = {
  top: Candidate | null; // the highlighted pick
  groups: { tier: Tier; items: Candidate[] }[]; // tierOrder; 'Low quality' and 'Likely fake' start collapsed
  total: number; // unique streams after de-duplication
};

export class StreamEngine {
  readonly ctx: TitleContext;
  readonly prefs: Prefs;
  readonly weights: Weights;
  #byKey = new Map<string, Candidate>();
  #byFile = new Map<string, Candidate>();
  #sorted: Candidate[] = [];
  #seq = 0;
  #pinned: Candidate | null = null;
  merges = { sameTorrent: 0, sameFile: 0 };

  constructor(ctx: TitleContext, prefs: Prefs = defaultPrefs, weights: Weights = defaultWeights) {
    this.ctx = ctx;
    this.prefs = prefs;
    this.weights = weights;
  }

  // One addon answered. Returns how many streams were new (not duplicates of earlier ones).
  add(addon: string, streams: Stream[]): number {
    const fresh: Candidate[] = [];
    const replaced = new Set<Candidate>();
    for (const stream of streams) {
      const c = makeCandidate(addon, stream, this.ctx, this.prefs, this.#seq++, this.weights);
      const fk = fileKey(c.parsed);
      const sameTorrent = this.#byKey.get(c.key);
      const existing = sameTorrent ?? (fk ? this.#byFile.get(fk) : undefined);
      if (!existing) {
        this.#index(c, fk);
        fresh.push(c);
        continue;
      }
      if (sameTorrent) this.merges.sameTorrent++;
      else this.merges.sameFile++;
      if (better(c, existing)) {
        c.alternates = [{ addon: existing.addon, stream: existing.stream }, ...existing.alternates];
        this.#index(c, fk);
        if (existing.key !== c.key) this.#byKey.set(existing.key, c);
        const efk = fileKey(existing.parsed);
        if (efk) this.#byFile.set(efk, c);
        if (fresh.includes(existing)) fresh.splice(fresh.indexOf(existing), 1, c);
        else {
          replaced.add(existing);
          fresh.push(c);
        }
        if (this.#pinned === existing) this.#pinned = c;
      } else {
        existing.alternates.push({ addon, stream });
      }
    }
    fresh.sort(compare);
    const kept = replaced.size ? this.#sorted.filter((c) => !replaced.has(c)) : this.#sorted;
    this.#sorted = mergeSorted(kept, fresh);
    return fresh.length - replaced.size;
  }

  #index(c: Candidate, fk: string | null) {
    this.#byKey.set(c.key, c);
    if (fk) this.#byFile.set(fk, c);
  }

  // Once the user starts moving through the list, the highlighted pick stays put even if a
  // later addon brings something better (#51).
  pinTop() {
    this.#pinned = this.view().top;
  }

  view(): RankedView {
    const groups = new Map<Tier, Candidate[]>(tierOrder.map((t) => [t, []]));
    let best: Candidate | null = null;
    for (const c of this.#sorted) {
      groups.get(c.tier)!.push(c);
      if (!best && c.tier !== 'Likely fake' && c.tier !== 'Low quality') best = c;
    }
    return {
      top: this.#pinned ?? best,
      groups: tierOrder.map((tier) => ({ tier, items: groups.get(tier)! })).filter((g) => g.items.length),
      total: this.#sorted.length,
    };
  }
}

function mergeSorted(a: Candidate[], b: Candidate[]): Candidate[] {
  if (!b.length) return a;
  if (!a.length) return b;
  const out = new Array<Candidate>(a.length + b.length);
  let i = 0, j = 0, k = 0;
  while (i < a.length && j < b.length) out[k++] = compare(a[i], b[j]) <= 0 ? a[i++] : b[j++];
  while (i < a.length) out[k++] = a[i++];
  while (j < b.length) out[k++] = b[j++];
  return out;
}
