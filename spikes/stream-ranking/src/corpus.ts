// Loads the recorded fixtures. Each stream gets a stable id: <addon>/<title>#<index>.
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Fixture, Stream, TitleContext } from './types.ts';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixturesDir = join(root, 'fixtures');

export type CorpusStream = { id: string; addon: string; config: Fixture['config']; title: string; stream: Stream };

export function loadTitles(): Map<string, TitleContext> {
  const list = JSON.parse(readFileSync(join(fixturesDir, 'titles.json'), 'utf8')) as TitleContext[];
  return new Map(list.map((t) => [t.slug, t]));
}

export function loadFixtures(): Fixture[] {
  const out: Fixture[] = [];
  for (const addon of readdirSync(fixturesDir, { withFileTypes: true })) {
    if (!addon.isDirectory()) continue;
    for (const file of readdirSync(join(fixturesDir, addon.name)).sort()) {
      if (file.endsWith('.json')) out.push(JSON.parse(readFileSync(join(fixturesDir, addon.name, file), 'utf8')));
    }
  }
  return out;
}

export function loadCorpus(): CorpusStream[] {
  return loadFixtures().flatMap((f) =>
    f.streams.map((stream, i) => ({ id: `${f.addon}/${f.title}#${i}`, addon: f.addon, config: f.config, title: f.title, stream })),
  );
}
