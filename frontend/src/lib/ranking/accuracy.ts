import type { Stream } from "@/lib/addon-protocol";
import { parseStreamResponse } from "@/lib/addon-protocol/parse";

import type { EpisodeMap, TitleContext } from "./context";
import { judge } from "./fakes";
import { parseStream, type Parsed } from "./parse";

// The parser's accuracy against the labelled corpus (#51): 360 streams from
// #6, hand-labelled by what each claims (the rules are in
// spikes/stream-ranking/labels/README.md). The targets are the CI gate;
// accuracy.test.ts checks them and writes corpus/accuracy.md.

type OneOrMany<T> = T | T[];

// An omitted field means null, [] or false. An array lists every
// acceptable answer.
export type Label = {
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
  // Genuine, but the release names the title only in another language or
  // spelling than the name asked for ("Cadena perpetua" for The Shawshank
  // Redemption); labelled for the "titles" split (#99).
  localized?: boolean;
  note?: string;
};

// corpus/labelled.json, from scripts/extract-ranking-corpus.ts: the spike's
// title records and the labelled streams, as the addons sent them.
export type Corpus = {
  titles: {
    slug: string;
    kind: string;
    type: string;
    id: string;
    name: string;
    aliases?: string[];
    // "manual": written by hand as a stand-in for TMDB's alternative titles
    // and translations (#99); replace with TMDB's when there is a key.
    aliasesSource?: string;
    year?: number;
    runtimeMin?: number;
    season?: number;
    episode?: number;
    // Long runners' numbers by season (#100), from the Kitsu addon.
    map?: EpisodeMap;
  }[];
  streams: {
    id: string;
    split: string;
    addon: string;
    title: string;
    stream: unknown;
    label: Label;
  }[];
};

// Dev was tuned on in #6; holdout only by its totals; blind was labelled
// after #6's parser was frozen; longrun (#100) is long-running anime asked
// for by absolute episode, labelled before the episode map existed. "titles"
// (#99) is Torrentio streams for titles with localized names and wrong-title
// fuzzy hits, labelled for the title check only (`fake`, `localized`, a
// CAM / TS `source`): it is left out of the field accuracy and of the CI gate,
// and reported on its own.
export type Split = "dev" | "holdout" | "blind" | "longrun" | "titles";

export type LabelledStream = {
  id: string;
  split: Split;
  addon: string;
  stream: Stream;
  label: Label;
  ctx: TitleContext;
};

export function labelled(corpus: Corpus): LabelledStream[] {
  const titles = new Map(
    corpus.titles.map(
      ({ slug, kind, type, id, name, aliases, year, runtimeMin, season, episode, map }) => {
        const ctx: TitleContext = {
          type: type === "movie" ? "movie" : "series",
          anime: kind === "anime",
          id,
          name,
          ...(aliases && { aliases }),
          ...(year && { year }),
          ...(runtimeMin && { runtimeMin }),
          ...(season !== undefined && { season }),
          ...(episode !== undefined && { episode }),
          ...(map && { map }),
        };
        return [slug, ctx];
      },
    ),
  );
  // Read as the addon client reads every answer.
  const { streams } = parseStreamResponse({ streams: corpus.streams.map((row) => row.stream) });
  return corpus.streams.map(({ id, split, addon, title, label }, index) => ({
    id,
    split:
      split === "dev" || split === "holdout" || split === "longrun" || split === "titles"
        ? split
        : "blind",
    addon,
    stream: streams[index]!,
    label,
    ctx: titles.get(title)!,
  }));
}

// The rows labelled in full, which the field accuracy and the gate count.
export const fieldRows = (rows: readonly LabelledStream[]) =>
  rows.filter((row) => row.split !== "titles");

export const parseLabelled = (row: LabelledStream): Parsed =>
  parseStream(row.stream, { type: row.ctx.type, anime: row.ctx.anime });

export const verdictOf = (row: LabelledStream) => judge(parseLabelled(row), row.ctx);

// --- Fields -------------------------------------------------------------------

export type Field = {
  name: string;
  // Per cent of labelled streams it must get right.
  target: number;
  got: (p: Parsed) => unknown;
  want: (label: Label) => unknown;
  same?: (got: unknown, want: unknown) => boolean;
};

const lower = (value: unknown) => (typeof value === "string" ? value.toLowerCase() : value);
const oneOf = (got: unknown, want: unknown) =>
  Array.isArray(want) ? want.includes(got) : got === want;
const oneOfIgnoringCase = (got: unknown, want: unknown) =>
  (Array.isArray(want) ? want : [want]).map(lower).includes(lower(got));
const sameSet = (got: unknown, want: unknown) => {
  const a = Array.isArray(got) ? got.map(String).toSorted() : [];
  const b = Array.isArray(want) ? want.map(String).toSorted() : [];
  return a.length === b.length && a.every((item, i) => item === b[i]);
};
// Within 3% of the labelled GiB, as addons round what they print.
const nearSize = (got: unknown, want: unknown) => {
  if (typeof want !== "number") return got === null;
  if (typeof got !== "number") return false;
  return Math.abs(got / 2 ** 30 - want) <= Math.max(0.03 * want, 0.01);
};

// Each target sits a little below what #6 reached over all 360, so a
// regression fails the build while label noise doesn't.
export const fields: Field[] = [
  {
    name: "resolution",
    target: 98,
    got: (p) => p.resolution,
    want: (l) => l.res ?? null,
    same: oneOf,
  },
  { name: "hdr", target: 97, got: (p) => p.hdr, want: (l) => l.hdr ?? [], same: sameSet },
  {
    name: "video codec",
    target: 97,
    got: (p) => p.videoCodec,
    want: (l) => l.vcodec ?? null,
    same: oneOf,
  },
  {
    name: "audio codec",
    target: 95,
    got: (p) => p.audioCodec,
    want: (l) => l.audio ?? null,
    same: oneOf,
  },
  { name: "channels", target: 95, got: (p) => p.channels, want: (l) => l.ch ?? null, same: oneOf },
  { name: "atmos", target: 98, got: (p) => p.atmos, want: (l) => l.atmos ?? false },
  {
    name: "size",
    target: 98,
    got: (p) => p.sizeBytes,
    want: (l) => l.sizeGB ?? null,
    same: nearSize,
  },
  { name: "source", target: 93, got: (p) => p.source, want: (l) => l.source ?? null, same: oneOf },
  {
    name: "release group",
    target: 85,
    got: (p) => p.group,
    want: (l) => l.group ?? null,
    same: oneOfIgnoringCase,
  },
  // Exact set: the least well-defined field.
  {
    name: "languages",
    target: 80,
    got: (p) => p.languages,
    want: (l) => l.langs ?? [],
    same: sameSet,
  },
  { name: "season", target: 97, got: (p) => p.season, want: (l) => l.season ?? null },
  { name: "episode", target: 95, got: (p) => p.episode, want: (l) => l.episode ?? null },
  { name: "pack", target: 90, got: (p) => p.pack, want: (l) => l.pack ?? false },
  { name: "cached", target: 100, got: (p) => p.cached, want: (l) => l.cached ?? null },
];

export type Miss = { id: string; got: unknown; want: unknown };

const percent = (part: number, whole: number) =>
  whole ? Math.round((1000 * part) / whole) / 10 : 0;

export function accuracy(rows: readonly LabelledStream[], field: Field) {
  const same = field.same ?? ((got: unknown, want: unknown) => got === want);
  const misses: Miss[] = [];
  for (const row of rows) {
    const got = field.got(parseLabelled(row));
    const want = field.want(row.label);
    if (!same(got, want)) misses.push({ id: row.id, got, want });
  }
  return { pct: percent(rows.length - misses.length, rows.length), misses };
}

// --- Fakes --------------------------------------------------------------------

export const fakeTargets = {
  // Per cent of genuine streams hidden as likely fake.
  hiddenFalsePositiveRateMax: 1,
  // Per cent of fakes hidden; raise it as title matching lands. 75 since the
  // episode map (#100): 82.5 over all 492, 78.9 over the original 360.
  hiddenRecallMin: 75,
  camTsRecallMin: 95,
  camTsFalsePositiveRateMax: 1,
};

// A label may accept several sources: "TSScreener" is ["ts", "scr"].
const lowQuality = (label: Label) =>
  [label.source].flat().some((source) => ["cam", "ts", "tc", "scr"].includes(String(source)));

export function fakeRates(rows: readonly LabelledStream[]) {
  let hiddenGenuine = 0;
  let genuine = 0;
  let caught = 0;
  let fakes = 0;
  let camCaught = 0;
  let cams = 0;
  let camWrong = 0;
  for (const row of rows) {
    const verdict = verdictOf(row);
    if (row.label.fake) {
      fakes++;
      if (verdict.bucket === "hidden") caught++;
    } else {
      genuine++;
      if (verdict.bucket === "hidden") hiddenGenuine++;
    }
    const cam = lowQuality(row.label);
    if (cam) cams++;
    if (verdict.reasons.includes("cam / ts")) {
      if (cam) camCaught++;
      else camWrong++;
    }
  }
  return {
    hiddenFalsePositiveRate: percent(hiddenGenuine, genuine),
    hiddenRecall: percent(caught, fakes),
    camTsRecall: percent(camCaught, cams),
    camTsFalsePositiveRate: percent(camWrong, rows.length - cams),
  };
}

// --- Report -------------------------------------------------------------------

type Rates = ReturnType<typeof fakeRates>;

// Accuracy per split, the fake checks' rates, and every miss, as Markdown.
export function report(everything: readonly LabelledStream[]): string {
  const rows = fieldRows(everything);
  const titles = everything.filter((row) => row.split === "titles");
  const splits = [
    ...(["dev", "holdout", "blind", "longrun"] as const).map(
      (split) => [split, rows.filter((row) => row.split === split)] as const,
    ),
    ["all", rows] as const,
  ];
  const head = (
    title: string,
    columns: readonly (readonly [string, readonly LabelledStream[]])[] = splits,
  ) => [
    `| ${title} | ${columns.map(([name, list]) => `${name} (n=${list.length})`).join(" | ")} | Target |`,
    `|---|${columns.map(() => "---:").join("|")}|---:|`,
  ];
  const out = [
    "# Ranking engine accuracy",
    "",
    "Written by `src/lib/ranking/accuracy.test.ts`; `vp test run -u` updates it.",
    "",
    ...head("Field"),
  ];
  for (const field of fields) {
    const pcts = splits.map(([, list]) => `${accuracy(list, field).pct}%`);
    out.push(`| ${field.name} | ${pcts.join(" | ")} | ≥ ${field.target}% |`);
  }
  // The title split has only fake labels, so it joins the fake table alone.
  const fakeSplits = titles.length ? [...splits, ["titles", titles] as const] : splits;
  const rates = fakeSplits.map(([, list]) => fakeRates(list));
  const rate = (name: string, key: keyof Rates, target: string) =>
    `| ${name} | ${rates.map((r) => `${r[key]}%`).join(" | ")} | ${target} |`;
  const t = fakeTargets;
  out.push(
    "",
    ...head("Fake checks", fakeSplits),
    rate(
      "Hidden, false-positive rate",
      "hiddenFalsePositiveRate",
      `≤ ${t.hiddenFalsePositiveRateMax}%`,
    ),
    rate("Hidden, recall", "hiddenRecall", `≥ ${t.hiddenRecallMin}%`),
    rate("CAM / TS recall", "camTsRecall", `≥ ${t.camTsRecallMin}%`),
    rate(
      "CAM / TS false-positive rate",
      "camTsFalsePositiveRate",
      `≤ ${t.camTsFalsePositiveRateMax}%`,
    ),
    "",
    "## Misses",
    "",
  );
  for (const field of fields) {
    const { misses } = accuracy(rows, field);
    if (!misses.length) continue;
    out.push(`### ${field.name}`, "");
    for (const { id, got, want } of misses) {
      out.push(`- \`${id}\`: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
    }
    out.push("");
  }
  out.push("### Fake checks", "");
  for (const row of everything) {
    const { bucket, reasons } = verdictOf(row);
    if ((bucket === "hidden") === !!row.label.fake) continue;
    const why = reasons.length ? ` (${reasons.join(", ")})` : "";
    const truth = row.label.fake ? "fake" : "genuine";
    const note = row.label.note ? `: ${row.label.note}` : "";
    out.push(`- \`${row.id}\`: ${bucket}${why}, labelled ${truth}${note}`);
  }
  return out.join("\n") + "\n";
}
