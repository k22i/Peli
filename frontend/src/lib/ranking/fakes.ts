import type { EpisodeMap, TitleContext } from "./context";
import type { Parsed } from "./parse";

// Fake and low-quality heuristics (#51, from #6). Each check gives a reason or
// nothing, and the reasons sort a stream into one bucket:
//   hidden       strong evidence it won't play what was asked for: the
//                collapsed "Likely fake" group
//   low quality  CAM, TS, TC or screener: real, but bad; its own collapsed
//                group
//   suspicious   weak evidence: shown, but ranked below clean streams

export type Reason =
  | "non-video file"
  | "extras"
  | "wrong episode"
  | "wrong season"
  | "episode for a movie"
  | "wrong year"
  | "too small"
  | "title mismatch"
  | "too large"
  | "cam / ts";

export type Bucket = "ok" | "suspicious" | "low quality" | "hidden";
export type Verdict = { bucket: Bucket; reasons: Reason[] };

// On the 360 labelled streams these hid no genuine one (#6).
const strong = new Set<Reason>([
  "non-video file",
  "extras",
  "wrong episode",
  "wrong season",
  "episode for a movie",
  "wrong year",
  "too small",
]);

// Mbps bounds. Below `minMbps` it can't be the whole video at any quality;
// above `maxMbps` it's bigger than its source allows (UHD Blu-ray peaks
// around 128 Mbps, streaming WEB-DLs around 40).
const minMbps = 0.2;
const maxMbps: Partial<Record<string, number>> = {
  remux: 140,
  bluray: 140,
  "web-dl": 50,
  webrip: 50,
  hdtv: 30,
};

const videoExtension =
  /^(mkv|mp4|avi|m4v|ts|m2ts|webm|mov|wmv|mpg|mpeg|flv|vob|iso|divx|ogm|rmvb)$/;

// The stream's bitrate over the title's runtime, when both are known and the
// size isn't a whole pack's.
export function mbps(p: Parsed, ctx: TitleContext): number | null {
  if (!p.sizeBytes || !ctx.runtimeMin || p.pack) return null;
  return (p.sizeBytes * 8) / (ctx.runtimeMin * 60) / 1e6;
}

// --- Title matching (#99) ------------------------------------------------------
//
// Does a release name the asked-for title? The title is its name or any alias
// (TMDB's alternative titles and translations, Kitsu's aliases), compared
// word by word, so "Cadena perpetua" and "Les évadés" count for The
// Shawshank Redemption once TMDB lists them. The verdict is reported but
// moves nothing (ADR-0049): it needs measuring with real TMDB titles first.

// Words that say nothing about which title it is: articles, particles and
// "part" in the languages releases come in.
const stopWords = new Set(
  (
    "the of and vs part no na wa " +
    "le la les el los las il lo gli der die das den de du des un une uno una et und do da dos um"
  ).split(" "),
);

const kana = /[぀-ヿ㐀-鿿]/u;

// A text's content words: lowercase, accents and apostrophes removed
// ("d'Amélie" is "damelie", "Pan's" is "pans"), in any script. Kana and Han
// have no spaces between words, so they are cut into pairs of characters.
// Single letters are dropped; single digits stay ("1+1", "Cars 2").
export function titleWords(text: string): string[] {
  const out: string[] = [];
  const plain = text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’`´]/g, "");
  for (const word of plain.split(/[^\p{L}\p{N}]+/u)) {
    if (!word || stopWords.has(word)) continue;
    if (kana.test(word)) {
      if (word.length === 1) out.push(word);
      else for (let i = 0; i + 1 < word.length; i++) out.push(word.slice(i, i + 2));
    } else if (word.length > 1 || /\d/.test(word)) {
      out.push(word);
    }
  }
  return out;
}

// The share of a title's words that the release names have, for the best
// matching of the name and aliases; null when no title has a word to compare.
export function titleCoverage(p: Parsed, ctx: TitleContext): number | null {
  const names = p.releaseNames.join(" ");
  // An elision as "d'Amélie" is also read as "d" and "Amélie".
  const have = new Set([...titleWords(names), ...titleWords(names.replace(/['’`´]/g, " "))]);
  let best: number | null = null;
  for (const title of [ctx.name, ...(ctx.aliases ?? [])]) {
    const want = [...new Set(titleWords(title))];
    if (!want.length) continue;
    best = Math.max(best ?? 0, want.filter((w) => have.has(w)).length / want.length);
  }
  return best;
}

// A season range in a release name: "S01-S22", "Seasons 16 to 21", "S01_S23".
const seasonRange =
  /(?:^|[^a-z0-9])(?:s|seasons?|saison|temporada)[ ._]?(\d{1,2})\s*(?:-|~|to|&|\+|_)\s*(?:s|seasons?)?[ ._]?(\d{1,2})(?![0-9])/gi;
// An episode range: "0001-1118", "892 ~ 1089", "E40-E928", "S01e296-300".
const episodeRange = /(?<![0-9])(\d{1,4})\s*(?:-|~|to)\s*e?(\d{1,4})(?![0-9])/gi;

function covers(names: readonly string[], range: RegExp, n: number): boolean {
  return names.some((name) =>
    [...name.matchAll(range)].some(
      (m) => Number(m[1]) < Number(m[2]) && Number(m[1]) <= n && n <= Number(m[2]),
    ),
  );
}

// Wrong season or wrong episode for a Kitsu episode whose numbers by season
// are known (#100, ADR-0050). A file is the asked-for episode when it says
// the season and episode of the map ("S22E15"), or the absolute number with
// no season, season 1 or a season that isn't the number of any other episode
// ("S01E1100", "Season 14 Voyage 09 / One Piece - 1000"), or Kitsu's own
// number with no season. A season pack is kept when its season is the
// episode's, a range of seasons or of episodes covers it, or the file name
// carries the absolute number; any other season is the wrong season.
// Episode ranges and releases with no season or episode aren't judged.
function mappedNumbering(p: Parsed, ctx: TitleContext, map: EpisodeMap): Reason | null {
  const { season: S, episode: E, absolute: A } = map;
  const { season, episode } = p;
  const longRunner = A !== E;
  if (episode !== null) {
    if (season === S && episode === E) return null;
    if (episode === A && (longRunner || season === null || season === 1 || season === S)) {
      return null;
    }
    if (episode === ctx.episode && season === null) return null;
    return season === null || season === S ? "wrong episode" : "wrong season";
  }
  if (season === null || season === S) return null;
  const names = [...p.releaseNames, ...(p.fileName ? [p.fileName] : [])];
  if (covers(names, seasonRange, S)) return null;
  if (longRunner) {
    if (covers(names, episodeRange, A)) return null;
    if (p.fileName && new RegExp(`(?<![0-9])${A}(?![0-9])`).test(p.fileName)) return null;
  }
  return "wrong season";
}

// The release names less than this share of the title's words.
export const minTitleCoverage = 0.5;

export function titleMismatch(p: Parsed, ctx: TitleContext): boolean {
  const coverage = titleCoverage(p, ctx);
  return coverage !== null && coverage < minTitleCoverage;
}

export function judge(p: Parsed, ctx: TitleContext): Verdict {
  const reasons: Reason[] = [];

  if (p.extension && !videoExtension.test(p.extension)) reasons.push("non-video file");
  if (p.extras) reasons.push("extras");

  if (ctx.type === "movie") {
    if (p.season !== null && p.episode !== null) reasons.push("episode for a movie");
    if (p.year !== null && ctx.year && Math.abs(p.year - ctx.year) > 1) reasons.push("wrong year");
  } else {
    // A show's files can carry any later year (its seasons), never an earlier
    // one.
    if (p.year !== null && ctx.year && p.year < ctx.year - 1) reasons.push("wrong year");
    if (ctx.id.startsWith("kitsu:")) {
      // Kitsu ids are per season and count episodes from 1 (or absolutely,
      // for long runners). "S02E01" for episode 1 is another season;
      // "S22E15" for episode 1100 may be the same episode numbered by season,
      // which can't be told without an episode map. With one (#100), the
      // map judges; without, what can't be judged isn't flagged.
      if (ctx.map) {
        const mapped = mappedNumbering(p, ctx, ctx.map);
        if (mapped) reasons.push(mapped);
      } else if (p.season !== null && p.season > 1 && p.episode === ctx.episode) {
        reasons.push("wrong season");
      } else if (p.episode !== null && (p.season === null || p.season === 1)) {
        if (p.episode !== ctx.episode) reasons.push("wrong episode");
      }
    } else if (p.season !== null && ctx.season !== undefined && p.season !== ctx.season) {
      reasons.push("wrong season");
    } else if (p.episode !== null && ctx.episode !== undefined && p.episode !== ctx.episode) {
      reasons.push("wrong episode");
    }
  }

  const rate = mbps(p, ctx);
  if (rate !== null && rate < minMbps) reasons.push("too small");
  const max = p.source ? maxMbps[p.source] : undefined;
  if (rate !== null && max && rate > max) reasons.push("too large");

  if (titleMismatch(p, ctx)) reasons.push("title mismatch");

  if (p.source === "cam" || p.source === "ts" || p.source === "tc" || p.source === "scr") {
    reasons.push("cam / ts");
  }

  // A title mismatch is reported but moves nothing: against Cinemeta's
  // English titles it was wrong 22 times out of 26, since releases use
  // localized ones ("Cadena perpetua", "Linternas"). It can count once the
  // metadata gives translated titles, starting as suspicious (#6).
  const bucket: Bucket = reasons.some((r) => strong.has(r))
    ? "hidden"
    : reasons.includes("cam / ts")
      ? "low quality"
      : reasons.some((r) => r !== "title mismatch")
        ? "suspicious"
        : "ok";
  return { bucket, reasons };
}
