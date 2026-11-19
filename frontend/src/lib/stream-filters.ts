import {
  collapsedTiers,
  compare,
  rememberedPick,
  type Candidate,
  type RankedView,
  type Remembered,
  type Resolution,
} from "@/lib/ranking";

// The stream picker's filters and sorts: narrowing the ranked view (#51) by
// what the streams claim, client side, before its rows are listed. Pure
// functions; the picker (and the player's stream switcher) keep the state.
//
// A filter is a facet with values. Values of one facet widen (4K or 1080p),
// facets narrow (4K and cached). The search box matches every word against
// the release and file names. The collapsed groups (CAM / TS, likely fakes)
// are filtered too, but never counted: their streams aren't offered.

export type Facet = "plays" | "resolution" | "hdr" | "audio" | "language" | "source" | "codec";

export type StreamFilters = {
  // The values chosen per facet; a facet with none doesn't filter.
  readonly chosen: Readonly<Partial<Record<Facet, readonly string[]>>>;
  // Words to find in the release and file names.
  readonly text: string;
};

export const noFilters: StreamFilters = { chosen: {}, text: "" };

// The chips chosen last last for the app's session, across pickers and the
// player's stream switcher; the search box is each one's own.
let session: StreamFilters["chosen"] = {};
export const sessionFilters = (): StreamFilters => ({ chosen: session, text: "" });
export function keepForSession(filters: StreamFilters) {
  session = filters.chosen;
}

// Within each quality group: the ranking's order, by size (season packs
// last, as their size isn't the episode's), or by seeders.
export type StreamSort = "best" | "size-desc" | "size-asc" | "seeders";
export const streamSorts: readonly StreamSort[] = ["best", "size-desc", "size-asc", "seeders"];
export const sortLabels: Record<StreamSort, string> = {
  best: "Best match",
  "size-desc": "Largest first",
  "size-asc": "Smallest first",
  seeders: "Most seeders",
};
export const isStreamSort = (value: unknown): value is StreamSort =>
  typeof value === "string" && (streamSorts as readonly string[]).includes(value);

// --- What a stream is, per facet ------------------------------------------------

const resolutionValue: Record<Resolution, string> = {
  "2160p": "4K",
  "1440p": "1080p",
  "1080p": "1080p",
  "720p": "720p",
  "576p": "SD",
  "480p": "SD",
  "360p": "SD",
};

const lossless = new Set(["truehd", "dts-x", "dts-hd", "lpcm", "flac"]);
const codecs = new Set(["hevc", "av1", "avc"]);

// The values a candidate has for a facet; none when it doesn't say.
export function valuesOf(facet: Facet, { parsed, source }: Candidate): string[] {
  switch (facet) {
    case "plays":
      if (parsed.cached === true) return ["cached"];
      if (parsed.cached === false) return ["uncached"];
      return parsed.infoHash ? ["p2p"] : [];
    case "resolution":
      return parsed.resolution ? [resolutionValue[parsed.resolution]] : [];
    case "hdr":
      return parsed.hdr.length ? [...parsed.hdr] : ["SDR"];
    case "audio": {
      const out: string[] = [];
      if (parsed.atmos) out.push("atmos");
      if (parsed.audioCodec && lossless.has(parsed.audioCodec)) out.push("lossless");
      if (parsed.channels === "5.1" || parsed.channels === "7.1") out.push("surround");
      return out;
    }
    case "language":
      return parsed.languages;
    case "source":
      return [source];
    case "codec":
      return parsed.videoCodec && codecs.has(parsed.videoCodec) ? [parsed.videoCodec] : [];
    default:
      return [];
  }
}

// The words of a search, lower case.
const words = (text: string) => text.toLowerCase().split(/\s+/).filter(Boolean);

function matchesText(candidate: Candidate, terms: readonly string[]): boolean {
  if (terms.length === 0) return true;
  const { fileName, releaseNames } = candidate.parsed;
  const haystack = [fileName ?? "", ...releaseNames].join("\n").toLowerCase();
  return terms.every((term) => haystack.includes(term));
}

function matchesFacet(candidate: Candidate, facet: Facet, chosen: readonly string[] | undefined) {
  if (!chosen?.length) return true;
  return valuesOf(facet, candidate).some((value) => chosen.includes(value));
}

// Whether a candidate passes every filter, or every one but `except`'s.
export function matches(candidate: Candidate, filters: StreamFilters, except?: Facet): boolean {
  for (const facet of facets) {
    if (facet !== except && !matchesFacet(candidate, facet, filters.chosen[facet])) return false;
  }
  return matchesText(candidate, words(filters.text));
}

export const isFiltered = (filters: StreamFilters) =>
  words(filters.text).length > 0 || facets.some((facet) => filters.chosen[facet]?.length);

// --- Changing the filters ---------------------------------------------------------

export function toggle(filters: StreamFilters, facet: Facet, value: string): StreamFilters {
  const current = filters.chosen[facet] ?? [];
  const next = current.includes(value) ? current.filter((v) => v !== value) : [...current, value];
  return { ...filters, chosen: { ...filters.chosen, [facet]: next } };
}

export const withText = (filters: StreamFilters, text: string): StreamFilters => ({
  ...filters,
  text,
});

// --- The chips ----------------------------------------------------------------------

export const facets: readonly Facet[] = [
  "plays",
  "resolution",
  "hdr",
  "audio",
  "language",
  "source",
  "codec",
];

export const facetLabels: Record<Facet, string> = {
  plays: "Plays now",
  resolution: "Resolution",
  hdr: "HDR",
  audio: "Audio",
  language: "Language",
  source: "Addon",
  codec: "Video codec",
};

// Each facet's values in the order they're offered, but languages and
// addons, which come from the streams.
const fixedValues: Partial<Record<Facet, readonly string[]>> = {
  plays: ["cached", "p2p", "uncached"],
  resolution: ["4K", "1080p", "720p", "SD"],
  hdr: ["DV", "HDR10+", "HDR10", "SDR"],
  audio: ["atmos", "lossless", "surround"],
  codec: ["hevc", "av1", "avc"],
};

const valueLabels: Record<string, string> = {
  cached: "Cached",
  p2p: "P2P",
  uncached: "Not cached",
  DV: "Dolby Vision",
  atmos: "Atmos",
  lossless: "Lossless",
  surround: "5.1 or more",
  hevc: "HEVC",
  av1: "AV1",
  avc: "H.264",
  multi: "Multi audio",
};

export type FacetOption = { value: string; label: string; count: number; chosen: boolean };
export type FacetChips = { facet: Facet; label: string; options: FacetOption[] };

export type ChipContext = {
  // The profile's audio languages, most preferred first: listed first.
  languages?: readonly string[];
  // A language code's name ("English").
  languageName?: (code: string) => string;
  // Addon (and plugin) names by source key, in the order they're listed.
  names?: ReadonlyMap<string, string>;
};

// Every candidate of a view outside the collapsed groups: what the chips count.
export const offered = (view: RankedView): Candidate[] =>
  view.groups.filter(({ tier }) => !collapsedTiers.has(tier)).flatMap(({ items }) => items);

// The chips for `candidates` (the unfiltered view's `offered`): a facet only
// when the streams differ on it (some have a value, others don't), or when
// one of its values is chosen. Each count is how many streams the chip would
// leave with the other facets' filters as they are.
export function facetChips(
  candidates: readonly Candidate[],
  filters: StreamFilters,
  context: ChipContext = {},
): FacetChips[] {
  const out: FacetChips[] = [];
  for (const facet of facets) {
    const chosen = filters.chosen[facet] ?? [];
    const all = new Map<string, number>();
    const narrowed = new Map<string, number>();
    for (const candidate of candidates) {
      const values = valuesOf(facet, candidate);
      for (const value of values) all.set(value, (all.get(value) ?? 0) + 1);
      if (!matches(candidate, filters, facet)) continue;
      for (const value of values) narrowed.set(value, (narrowed.get(value) ?? 0) + 1);
    }
    const differ = [...all.values()].some((count) => count < candidates.length);
    if (!differ && chosen.length === 0) continue;
    const values = orderValues(facet, [...new Set([...all.keys(), ...chosen])], context);
    const options = values.map((value) => ({
      value,
      label: optionLabel(facet, value, context),
      count: narrowed.get(value) ?? 0,
      chosen: chosen.includes(value),
    }));
    out.push({ facet, label: facetLabels[facet], options });
  }
  return out;
}

function orderValues(facet: Facet, values: string[], context: ChipContext): string[] {
  const fixed = fixedValues[facet];
  if (fixed) return fixed.filter((value) => values.includes(value));
  if (facet === "source") {
    const order = [...(context.names?.keys() ?? [])];
    const at = (value: string) => {
      const index = order.indexOf(value);
      return index < 0 ? order.length : index;
    };
    return values.toSorted((a, b) => at(a) - at(b));
  }
  // Languages: the profile's first, in its order, then "Multi", then by name.
  const preferred = context.languages ?? [];
  const rank = (code: string) => {
    const index = preferred.indexOf(code);
    if (index >= 0) return index;
    return code === "multi" ? preferred.length : preferred.length + 1;
  };
  return values.toSorted(
    (a, b) =>
      rank(a) - rank(b) ||
      optionLabel(facet, a, context).localeCompare(optionLabel(facet, b, context)),
  );
}

export function optionLabel(facet: Facet, value: string, context: ChipContext = {}): string {
  if (facet === "source") return context.names?.get(value) ?? value;
  if (facet === "language" && value !== "multi") {
    return context.languageName?.(value) ?? value.toUpperCase();
  }
  return valueLabels[value] ?? value;
}

// What the filters keep, for the top pick's card: "4K only", "4K or 1080p
// · Cached only", "“remux” only", or "3 filters" past two.
export function filtersLabel(filters: StreamFilters, context: ChipContext = {}): string | null {
  const parts = facets.flatMap((facet) => {
    const chosen = filters.chosen[facet] ?? [];
    if (!chosen.length) return [];
    const ordered = orderValues(facet, [...chosen], context);
    return [ordered.map((value) => optionLabel(facet, value, context)).join(" or ")];
  });
  const terms = filters.text.trim();
  if (terms) parts.push(`“${terms}”`);
  if (parts.length === 0) return null;
  if (parts.length > 2) return `${parts.length} filters`;
  return `${parts.join(" · ")} only`;
}

// --- Sorting ------------------------------------------------------------------------

const sizeOf = (candidate: Candidate) => candidate.parsed.sizeBytes ?? null;
const seedsOf = (candidate: Candidate) => candidate.parsed.seeders ?? -1;
// Known sizes, then unknown ones, then season packs.
const sizeBand = (candidate: Candidate) =>
  candidate.parsed.pack ? 2 : sizeOf(candidate) === null ? 1 : 0;

// Sorts one group's items, which come in the ranking's order: that order
// breaks every tie. Sizes unknown go after the known ones, season packs
// after those; seeders unknown go last.
export function sortItems(items: readonly Candidate[], sort: StreamSort): Candidate[] {
  if (sort === "best") return [...items];
  if (sort === "seeders") return items.toSorted((a, b) => seedsOf(b) - seedsOf(a));
  const sign = sort === "size-desc" ? -1 : 1;
  return items.toSorted(
    (a, b) => sizeBand(a) - sizeBand(b) || sign * ((sizeOf(a) ?? 0) - (sizeOf(b) ?? 0)),
  );
}

// Whether a sort has anything to sort by: seeders only with P2P streams.
export const sortsAvailable = (candidates: readonly Candidate[]): StreamSort[] =>
  candidates.some((c) => c.parsed.cached === null && c.parsed.infoHash)
    ? [...streamSorts]
    : streamSorts.filter((sort) => sort !== "seeders");

// --- The filtered view ----------------------------------------------------------------

export type TopRule = {
  // The show's remembered source (#58): its closest match leads.
  remembered?: Remembered | null;
  maxResolution?: Resolution;
  // A top pick the user pinned for these filters, by key.
  pinned?: string | null;
};

// The view with the filters and the sort applied: the groups keep their
// order and drop when empty; the top pick stays when it passes, else it's the
// best that passes outside the collapsed groups (or the remembered source's
// closest match). Unfiltered and by best match, it's `view` itself.
export function filterView(
  view: RankedView,
  filters: StreamFilters,
  sort: StreamSort,
  rule: TopRule = {},
): RankedView {
  const filtered = isFiltered(filters);
  if (!filtered && sort === "best") return view;
  const groups = view.groups.flatMap(({ tier, items }) => {
    const kept = filtered ? items.filter((c) => matches(c, filters)) : items;
    return kept.length ? [{ tier, items: sortItems(kept, sort) }] : [];
  });
  const total = groups.reduce((sum, { items }) => sum + items.length, 0);
  return { top: filteredTop(view, groups, filters, rule), groups, total };
}

function filteredTop(
  view: RankedView,
  groups: RankedView["groups"],
  filters: StreamFilters,
  { remembered, maxResolution = "2160p", pinned }: TopRule,
): Candidate | null {
  if (!isFiltered(filters)) return view.top;
  if (view.top && matches(view.top, filters)) return view.top;
  const ranked = groups.flatMap(({ items }) => items).toSorted(compare);
  if (pinned) {
    const kept = ranked.find((c) => c.key === pinned);
    if (kept) return kept;
  }
  const best = ranked.find((c) => !collapsedTiers.has(c.tier)) ?? null;
  return (remembered && rememberedPick(remembered, ranked, best, maxResolution)) || best;
}

// The filters' identity, for state kept per set of filters.
export const filtersKey = (filters: StreamFilters) =>
  JSON.stringify([
    facets.map((facet) => (filters.chosen[facet] ?? []).toSorted()),
    words(filters.text),
  ]);
