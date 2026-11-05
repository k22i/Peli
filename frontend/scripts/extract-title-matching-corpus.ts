// Adds the title-matching rows (#99) to the ranking engine's labelled corpus:
// Torrentio streams recorded for films and shows whose releases use other
// names, labelled by reading their release names (`split: "titles"`).
//
//   node scripts/extract-title-matching-corpus.ts
//
// Reads spikes/stream-ranking/fixtures/titles-matching.json, the torrentio
// fixtures named `m-*` and labels/title-matching.jsonl. Rows are appended at
// the end of corpus/labelled.json; running it again replaces them, and every
// other row is left as it is. The titles' aliases were written by hand as
// stand-ins for TMDB's alternative titles and translations
// (`aliasesSource: "manual"`); replace them with TMDB's when there is a key.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const spike = join(here, "../../spikes/stream-ranking");
const file = join(here, "../src/lib/ranking/corpus/labelled.json");

type Row = {
  id: string;
  split: string;
  addon: string;
  title: string;
  stream: unknown;
  label: unknown;
};
type Title = { slug: string };

const corpus: { titles: Title[]; streams: Row[] } = JSON.parse(readFileSync(file, "utf8"));
const matching: (Title & { why?: string })[] = JSON.parse(
  readFileSync(join(spike, "fixtures/titles-matching.json"), "utf8"),
);

const labels = readFileSync(join(spike, "labels/title-matching.jsonl"), "utf8")
  .split("\n")
  .filter(Boolean)
  .map((line): { id: string } & Record<string, unknown> => JSON.parse(line));

const rows = labels.map(({ id, ...label }): Row => {
  const [, addon, title, index] = /^([^/]+)\/([^#]+)#(\d+)$/.exec(id) ?? [];
  const fixture = JSON.parse(
    readFileSync(join(spike, "fixtures", addon!, `${title}.json`), "utf8"),
  );
  const stream = fixture.streams[Number(index)];
  if (!stream) throw new Error(`no stream for ${id}`);
  return { id, split: "titles", addon: addon!, title: title!, stream, label };
});

const slugs = new Set(matching.map((t) => t.slug));
const titles = [...corpus.titles.filter((t) => !slugs.has(t.slug)), ...matching];
const streams = [...corpus.streams.filter((row) => row.split !== "titles"), ...rows];
writeFileSync(file, JSON.stringify({ titles, streams }, null, 1) + "\n");
console.log(`${rows.length} title-matching rows, ${matching.length} titles → ${file}`);
