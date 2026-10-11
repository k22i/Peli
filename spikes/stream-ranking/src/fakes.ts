// Fake and low-quality heuristics. Each check returns a reason or nothing; the verdict sorts a
// stream into one of three buckets:
//   hidden      strong evidence it won't play what was asked for (collapsed "likely fake" group)
//   suspicious  weak evidence; shown, but ranked below clean streams
//   low quality CAM / TS / TC / screener: real, but bad; its own collapsed group
import type { Parsed } from './parse.ts';
import type { TitleContext } from './types.ts';

export type Reason =
  | 'non-video file'
  | 'extras'
  | 'wrong episode'
  | 'wrong season'
  | 'episode for a movie'
  | 'wrong year'
  | 'too small'
  | 'title mismatch'
  | 'too large'
  | 'cam / ts';

export type Verdict = { bucket: 'ok' | 'suspicious' | 'hidden' | 'low quality'; reasons: Reason[] };

const strong = new Set<Reason>(['non-video file', 'extras', 'wrong episode', 'wrong season', 'episode for a movie', 'wrong year', 'too small']);

// Mbps bounds. Below `min` it can't be the whole video at any quality; above `max` it's bigger
// than the source format allows (UHD Blu-ray peaks around 128 Mbps; streaming WEB-DLs ~40).
const minMbps = 0.2;
const maxMbps: Record<string, number> = { remux: 140, bluray: 140, 'web-dl': 50, webrip: 50, hdtv: 30 };

export function mbps(p: Parsed, ctx: TitleContext): number | null {
  if (!p.sizeBytes || !ctx.runtimeMin || p.pack) return null;
  return (p.sizeBytes * 8) / (ctx.runtimeMin * 60) / 1e6;
}

const words = (s: string) =>
  s
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w.length > 1 && !['the', 'of', 'and', 'vs', 'part', 'no', 'na', 'wa'].includes(w));

function titleOverlap(p: Parsed, ctx: TitleContext): number | null {
  const names = p.releaseNames.join(' ');
  // Cyrillic / CJK / Thai release names: no Latin title to compare against.
  if (/[Ѐ-ӿ฀-๿぀-ヿ㐀-鿿가-힯]/.test(names)) return null;
  const have = new Set(words(names));
  let best = 0;
  for (const title of [ctx.name, ...(ctx.aliases ?? [])]) {
    const want = words(title);
    if (!want.length) continue;
    best = Math.max(best, want.filter((w) => have.has(w)).length / want.length);
  }
  return best;
}

export function judge(p: Parsed, ctx: TitleContext): Verdict {
  const reasons: Reason[] = [];

  if (p.extension && !/^(mkv|mp4|avi|m4v|ts|m2ts|webm|mov|wmv|mpg|mpeg|flv|vob|iso|divx|ogm|rmvb)$/.test(p.extension)) {
    reasons.push('non-video file');
  }
  if (p.extras) reasons.push('extras');

  if (ctx.type === 'movie') {
    if (p.season !== null && p.episode !== null) reasons.push('episode for a movie');
    if (p.year !== null && ctx.year && Math.abs(p.year - ctx.year) > 1) reasons.push('wrong year');
  } else {
    // A show's files can carry any later year (seasons), never an earlier one.
    if (p.year !== null && ctx.year && p.year < ctx.year - 1) reasons.push('wrong year');
    const kitsu = ctx.id.startsWith('kitsu:');
    if (kitsu) {
      // Kitsu ids are per season and count episodes from 1 (or absolutely, for long shows).
      // "S02E01" for episode 1 is another season; "S22E15" for episode 1100 may be the same
      // episode under seasonal numbering, which we can't map without an episode table.
      if (p.season !== null && p.season > 1 && p.episode === ctx.episode) reasons.push('wrong season');
      else if (p.episode !== null && (p.season === null || p.season === 1) && p.episode !== ctx.episode) reasons.push('wrong episode');
    } else {
      if (p.season !== null && ctx.season !== undefined && p.season !== ctx.season) reasons.push('wrong season');
      else if (p.episode !== null && ctx.episode !== undefined && p.episode !== ctx.episode) reasons.push('wrong episode');
    }
  }

  const rate = mbps(p, ctx);
  if (rate !== null && rate < minMbps) reasons.push('too small');
  if (rate !== null && p.source && maxMbps[p.source] && rate > maxMbps[p.source]) reasons.push('too large');

  const overlap = titleOverlap(p, ctx);
  if (overlap === 0) reasons.push('title mismatch');

  if (p.source === 'cam' || p.source === 'ts' || p.source === 'tc' || p.source === 'scr') reasons.push('cam / ts');

  // 'title mismatch' is reported but doesn't move a stream: on the labelled set it was wrong
  // 17 times out of 19, because releases use localized titles ("Cadena perpetua", "Linternas")
  // that Cinemeta doesn't list. It needs localized aliases from the metadata source first.
  const bucket = reasons.some((r) => strong.has(r))
    ? 'hidden'
    : reasons.includes('cam / ts')
      ? 'low quality'
      : reasons.some((r) => r !== 'title mismatch')
        ? 'suspicious'
        : 'ok';
  return { bucket, reasons };
}
