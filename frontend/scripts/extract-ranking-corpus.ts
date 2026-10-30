// Copies the ranking engine's labelled corpus (#51) out of the stream-ranking
// spike (#6): the 360 hand-labelled streams, each with its split, the title
// it was asked for, and its label.
//
//   node scripts/extract-ranking-corpus.ts
//
// The spike's fixtures already have debrid keys and opaque URL tokens
// redacted (spikes/stream-ranking/src/redact.ts). Labels follow the rules in
// spikes/stream-ranking/labels/README.md. Fixtures are for tests only; no
// content links go in docs.
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const spike = join(here, "../../spikes/stream-ranking");
const out = join(here, "../src/lib/ranking/corpus/labelled.json");

type Row = Record<string, unknown> & { id: string };

const lines = (file: string): Row[] =>
  readFileSync(join(spike, "labels", file), "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));

const splits = new Map(
  [...lines("sample.jsonl"), ...lines("blind-sample.jsonl")].map((row) => [row.id, row["split"]]),
);

const streams = new Map<string, unknown>();
for (const addon of readdirSync(join(spike, "fixtures"), { withFileTypes: true })) {
  if (!addon.isDirectory()) continue;
  for (const file of readdirSync(join(spike, "fixtures", addon.name))) {
    const fixture = JSON.parse(readFileSync(join(spike, "fixtures", addon.name, file), "utf8"));
    fixture.streams.forEach((stream: unknown, index: number) =>
      streams.set(`${fixture.addon}/${fixture.title}#${index}`, stream),
    );
  }
}

const titles = JSON.parse(readFileSync(join(spike, "fixtures/titles.json"), "utf8"));

const rows = [...lines("labels.jsonl"), ...lines("blind-labels.jsonl")].map(({ id, ...label }) => {
  const stream = streams.get(id);
  const split = splits.get(id);
  if (!stream || !split) throw new Error(`no stream or split for ${id}`);
  const [, addon, title] = /^([^/]+)\/([^#]+)#/.exec(id) ?? [];
  return { id, split, addon, title, stream, label };
});

writeFileSync(out, JSON.stringify({ titles, streams: rows }, null, 1) + "\n");
console.log(`${rows.length} labelled streams → ${out}`);
