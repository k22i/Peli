// Loads the hand labels and joins them with the corpus streams and title context.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCorpus, loadTitles, root, type CorpusStream } from './corpus.ts';
import type { TitleContext } from './types.ts';

type OneOrMany<T> = T | T[];

export type Label = {
  id: string;
  res?: OneOrMany<string | null>;
  hdr?: string[];
  vcodec?: OneOrMany<string | null>;
  audio?: OneOrMany<string | null>;
  ch?: OneOrMany<string | null>;
  atmos?: boolean;
  sizeGB?: number | null;
  pack?: boolean;
  source?: OneOrMany<string | null>;
  group?: OneOrMany<string | null>;
  langs?: string[];
  season?: number | null;
  episode?: number | null;
  cached?: boolean | null;
  fake?: boolean;
  note?: string;
};

export type Split = 'dev' | 'holdout' | 'blind';
export type LabelledStream = CorpusStream & { label: Label; split: Split; ctx: TitleContext };

// dev + holdout come from labels.jsonl; blind (labelled after the parser was frozen) from
// blind-labels.jsonl.
export function loadLabelled(): LabelledStream[] {
  const read = (f: string) =>
    existsSync(join(root, 'labels', f))
      ? readFileSync(join(root, 'labels', f), 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
  const samples = [...read('sample.jsonl'), ...read('blind-sample.jsonl')] as { id: string; split: Split }[];
  const splits = new Map<string, Split>(samples.map((s) => [s.id, s.split]));
  const corpus = new Map(loadCorpus().map((c) => [c.id, c]));
  const titles = loadTitles();
  return [...read('labels.jsonl'), ...read('blind-labels.jsonl')].map((label: Label) => {
    const c = corpus.get(label.id);
    if (!c) throw new Error(`label for unknown stream ${label.id}`);
    return { ...c, label, split: splits.get(label.id)!, ctx: titles.get(c.title)! };
  });
}
