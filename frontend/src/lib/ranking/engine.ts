import type { Stream } from "@/lib/addon-protocol";

import type { TitleContext } from "./context";
import { rememberedPick } from "./remembered";
import {
  better,
  candidate,
  collapsedTiers,
  compare,
  defaultPrefs,
  defaultWeights,
  fileKey,
  tierOrder,
  tiers,
  type Candidate,
  type Prefs,
  type Tier,
  type Weights,
} from "./score";

// The ranking engine (#51): fed each addon's (or plugin's) answer as it
// arrives, in slices, it keeps one de-duplicated list ranked. Re-ranking is
// incremental: new streams are parsed and sorted on their own, then merged
// into the sorted list, so a slice of ~150 fits in a frame (#6).

export type RankedGroup<C = Candidate> = { tier: Tier; items: C[] };

export type RankedView<C = Candidate> = {
  // The highlighted pick: the best outside the collapsed groups (or the
  // closest match to the show's remembered source, #58), or the one pinned
  // when the user started navigating.
  top: C | null;
  // In `tierOrder(prefs)` order, without empty ones.
  groups: RankedGroup<C>[];
  // Unique streams, after de-duplication.
  total: number;
};

export class StreamEngine {
  readonly ctx: TitleContext;
  readonly prefs: Prefs;
  readonly weights: Weights;
  readonly #byKey = new Map<string, Candidate>();
  readonly #byFile = new Map<string, Candidate>();
  #sorted: Candidate[] = [];
  #seq = 0;
  #pinned: Candidate | null = null;
  #changed = new Set<Candidate>();

  constructor(ctx: TitleContext, prefs: Prefs = defaultPrefs, weights: Weights = defaultWeights) {
    this.ctx = ctx;
    this.prefs = prefs;
    this.weights = weights;
  }

  // One source answered, or one slice of its answer. Each stream gets the
  // next arrival number (`seq`), from 0. Returns how many were new rather
  // than copies of ones already listed.
  add(source: string, streams: readonly Stream[]): number {
    const fresh: Candidate[] = [];
    const replaced = new Set<Candidate>();
    for (const stream of streams) {
      const c = candidate(source, stream, this.#seq++, this.ctx, this.prefs, this.weights);
      const file = fileKey(c.parsed);
      const existing = this.#byKey.get(c.key) ?? (file ? this.#byFile.get(file) : undefined);
      if (!existing) {
        this.#index(c, file);
        fresh.push(c);
        this.#changed.add(c);
        continue;
      }
      if (better(c, existing)) {
        // The new copy plays sooner: it takes the old one's place, and the
        // old one becomes its first fallback.
        c.alternates = [
          { source: existing.source, seq: existing.seq, stream: existing.stream },
          ...existing.alternates,
        ];
        this.#index(c, file);
        if (existing.key !== c.key) this.#byKey.set(existing.key, c);
        const existingFile = fileKey(existing.parsed);
        if (existingFile) this.#byFile.set(existingFile, c);
        const at = fresh.indexOf(existing);
        if (at >= 0) fresh.splice(at, 1, c);
        else {
          replaced.add(existing);
          fresh.push(c);
        }
        this.#changed.delete(existing);
        this.#changed.add(c);
        if (this.#pinned === existing) this.#pinned = c;
      } else {
        existing.alternates.push({ source, seq: c.seq, stream });
        this.#changed.add(existing);
      }
    }
    fresh.sort(compare);
    const kept = replaced.size ? this.#sorted.filter((c) => !replaced.has(c)) : this.#sorted;
    this.#sorted = mergeSorted(kept, fresh);
    return fresh.length - replaced.size;
  }

  #index(c: Candidate, file: string | null) {
    this.#byKey.set(c.key, c);
    if (file) this.#byFile.set(file, c);
  }

  // The candidates added or changed (new alternates) since the last call.
  takeChanges(): Candidate[] {
    const changed = [...this.#changed];
    this.#changed = new Set();
    return changed;
  }

  // The user started moving through the list: the highlighted pick stays put,
  // even if a later answer brings a better one.
  pinTop() {
    this.#pinned ??= this.#best();
  }

  // The best outside the collapsed groups, or the closest match to the
  // source remembered for the show (#58).
  #best(): Candidate | null {
    const best = this.#sorted.find((c) => !collapsedTiers.has(c.tier)) ?? null;
    const { remembered } = this.prefs;
    return (
      (remembered && rememberedPick(remembered, this.#sorted, best, this.prefs.maxResolution)) ||
      best
    );
  }

  view(): RankedView {
    const groups = new Map<Tier, Candidate[]>(tiers.map((tier) => [tier, []]));
    for (const c of this.#sorted) groups.get(c.tier)!.push(c);
    return {
      top: this.#pinned ?? this.#best(),
      groups: tierOrder(this.prefs).flatMap((tier) => {
        const items = groups.get(tier)!;
        return items.length ? [{ tier, items }] : [];
      }),
      total: this.#sorted.length,
    };
  }
}

function mergeSorted(a: Candidate[], b: Candidate[]): Candidate[] {
  if (!b.length) return a;
  if (!a.length) return b;
  const out: Candidate[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) out.push(compare(a[i]!, b[j]!) <= 0 ? a[i++]! : b[j++]!);
  while (i < a.length) out.push(a[i++]!);
  while (j < b.length) out.push(b[j++]!);
  return out;
}

// Ranks a whole list at once: for the next-episode auto-pick (#58) and the
// in-player switcher (#68), which have every answer already.
export function rankStreams(
  ctx: TitleContext,
  answers: readonly { source: string; streams: readonly Stream[] }[],
  prefs: Prefs = defaultPrefs,
  weights: Weights = defaultWeights,
): RankedView {
  const engine = new StreamEngine(ctx, prefs, weights);
  for (const { source, streams } of answers) engine.add(source, streams);
  return engine.view();
}
