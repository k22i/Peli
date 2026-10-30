import type { TitleContext } from "./context";
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

const stopWords = new Set(["the", "of", "and", "vs", "part", "no", "na", "wa"]);
const words = (text: string) =>
  text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .split(" ")
    .filter((word) => word.length > 1 && !stopWords.has(word));

// The share of the best-matching title's words that the release names
// share; null for Cyrillic, Thai, Japanese, Chinese or Korean release names,
// which have no Latin title to compare.
function titleOverlap(p: Parsed, ctx: TitleContext): number | null {
  const names = p.releaseNames.join(" ");
  if (/[Ѐ-ӿ฀-๿぀-ヿ㐀-鿿가-힯]/.test(names)) return null;
  const have = new Set(words(names));
  let best = 0;
  for (const title of [ctx.name, ...(ctx.aliases ?? [])]) {
    const want = words(title);
    if (want.length) best = Math.max(best, want.filter((w) => have.has(w)).length / want.length);
  }
  return best;
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
      // which can't be told without an episode map.
      if (p.season !== null && p.season > 1 && p.episode === ctx.episode) {
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

  if (titleOverlap(p, ctx) === 0) reasons.push("title mismatch");

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
