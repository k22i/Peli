// Scoring, grouping and cross-addon de-duplication. All weights live in `defaultWeights`.
import { judge, mbps, type Verdict } from './fakes.ts';
import { parseStream, type Parsed, type Resolution } from './parse.ts';
import type { Stream, TitleContext } from './types.ts';

export type Prefs = {
  languages: string[]; // preferred audio languages, most preferred first; [] = no preference
  maxResolution: Resolution; // what the display / user allows
  hdr: boolean; // the display shows HDR10
  dolbyVision: boolean; // the display shows Dolby Vision
  debrid: boolean; // the user has a debrid service
};

export const defaultPrefs: Prefs = { languages: [], maxResolution: '2160p', hdr: false, dolbyVision: false, debrid: false };

// The order of importance from #51: cached on debrid, then quality, then a plausible size.
// Each band is wide enough that a lower band can't overturn a higher one, except where noted.
export const defaultWeights = {
  cached: 10_000, // cached on the user's debrid: plays at once
  uncachedDebrid: 0, // needs a download first
  p2pSeedersPerLog10: 150, // P2P only: 1 seed 0, 10 seeds 150, 1000 seeds 450
  p2pDeadSwarm: -2_000, // P2P with 0 seeders
  resolution: { '2160p': 4_000, '1440p': 3_500, '1080p': 3_000, '720p': 2_000, '576p': 1_200, '480p': 1_000, '360p': 500, unknown: 1_500 },
  aboveMaxResolution: -6_000, // over the display / user cap: falls below everything that fits
  source: { remux: 600, bluray: 500, 'web-dl': 450, webrip: 350, hdtv: 200, dvd: 150, other: 100, unknown: 250, cam: 0, ts: 0, tc: 0, scr: 0 },
  hdrShown: { DV: 300, 'HDR10+': 250, HDR10: 200 }, // only when the display can show it
  dvWithoutFallback: -800, // Dolby Vision with no HDR10 layer on a non-DV display: wrong colours
  audio: { truehd: 120, 'dts-x': 120, 'dts-hd': 100, lpcm: 100, flac: 80, eac3: 60, dts: 50, ac3: 40, opus: 30, aac: 20, mp3: 0, unknown: 20 },
  atmos: 40,
  videoCodec: { hevc: 40, av1: 40, avc: 20, vc1: 0, mpeg2: -50, xvid: -150, unknown: 0 },
  // Size: log2(bitrate / expected floor for the resolution) × 60, clamped. Small effect inside
  // a quality band; strongly negative only for starved encodes.
  sizePerDoubling: 60,
  sizeClamp: [-400, 120] as [number, number],
  expectedMbps: { '2160p': 8, '1440p': 6, '1080p': 3, '720p': 1.5, '576p': 1, '480p': 0.8, '360p': 0.5, unknown: 1.5 },
  preferredLanguage: 1_500, // first preferred language present (later ones get less)
  otherLanguageOnly: -2_500, // languages are stated and none is preferred (and not 'multi')
  suspicious: -3_000,
};

export type Weights = typeof defaultWeights;

export type Tier = '4K' | '1080p' | '720p' | 'SD' | 'Unknown' | 'Low quality' | 'Likely fake';
const tierOf = (p: Parsed, v: Verdict): Tier =>
  v.bucket === 'hidden'
    ? 'Likely fake'
    : v.bucket === 'low quality'
      ? 'Low quality'
      : p.resolution === '2160p'
        ? '4K'
        : p.resolution === '1440p' || p.resolution === '1080p'
          ? '1080p'
          : p.resolution === '720p'
            ? '720p'
            : p.resolution
              ? 'SD'
              : 'Unknown';
export const tierOrder: Tier[] = ['4K', '1080p', '720p', 'SD', 'Unknown', 'Low quality', 'Likely fake'];

export type Candidate = {
  key: string;
  addon: string;
  stream: Stream;
  parsed: Parsed;
  verdict: Verdict;
  score: number;
  tier: Tier;
  alternates: { addon: string; stream: Stream }[]; // same file from other addons / torrents
  seq: number; // arrival order, the final tie-break so the order is stable
};

const resRank: Resolution[] = ['360p', '480p', '576p', '720p', '1080p', '1440p', '2160p'];

export function scoreStream(p: Parsed, v: Verdict, ctx: TitleContext, prefs: Prefs, w: Weights = defaultWeights): number {
  let s = 0;
  if (p.cached === true) s += w.cached;
  else if (p.cached === false) s += w.uncachedDebrid;
  else if (p.seeders !== null) s += p.seeders === 0 ? w.p2pDeadSwarm : Math.log10(p.seeders) * w.p2pSeedersPerLog10;

  const res = p.resolution ?? 'unknown';
  s += w.resolution[res];
  if (p.resolution && resRank.indexOf(p.resolution) > resRank.indexOf(prefs.maxResolution)) s += w.aboveMaxResolution;
  s += w.source[p.source ?? 'unknown'];

  if (p.hdr.includes('DV') && !prefs.dolbyVision && !p.hdr.includes('HDR10') && !p.hdr.includes('HDR10+')) s += w.dvWithoutFallback;
  const shown = p.hdr.filter((h) => (h === 'DV' ? prefs.dolbyVision : prefs.hdr));
  if (shown.length) s += Math.max(...shown.map((h) => w.hdrShown[h]));

  s += w.audio[p.audioCodec ?? 'unknown'] + (p.atmos ? w.atmos : 0);
  s += w.videoCodec[p.videoCodec ?? 'unknown'];

  const rate = mbps(p, ctx);
  if (rate !== null && rate > 0) {
    const doubling = Math.log2(rate / w.expectedMbps[res]) * w.sizePerDoubling;
    s += Math.min(w.sizeClamp[1], Math.max(w.sizeClamp[0], doubling));
  }

  if (prefs.languages.length && p.languages.length) {
    const hit = prefs.languages.findIndex((l) => p.languages.includes(l));
    if (hit >= 0) s += w.preferredLanguage / (hit + 1);
    else if (!p.languages.includes('multi')) s += w.otherLanguageOnly;
  }
  if (v.bucket === 'suspicious') s += w.suspicious;
  return Math.round(s);
}

// --- De-duplication -------------------------------------------------------------------------

const normName = (n: string) =>
  n
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, '')
    .replace(/[^a-z0-9]+/g, '');

// Same torrent and same file → one key. The file is named when we know it; fileIdx is the
// fallback (Torrentio P2P); the bare hash covers single-file torrents.
export function dedupKey(p: Parsed): string | null {
  if (!p.infoHash) return null;
  if (p.fileName) return `${p.infoHash}:${normName(p.fileName)}`;
  if (p.fileIdx !== null) return `${p.infoHash}:#${p.fileIdx}`;
  return p.infoHash;
}

// Same file name and size within 1% → same file even from different torrents.
export function fileKey(p: Parsed): string | null {
  if (!p.fileName || !p.sizeBytes || !/\.[a-z0-9]{2,4}$/i.test(p.fileName)) return null;
  return `${normName(p.fileName)}:${Math.round(Math.log(p.sizeBytes) / Math.log(1.01))}`;
}

// Prefer what plays soonest: cached debrid, then uncached debrid, then P2P; then the score.
const playability = (c: Candidate) => (c.parsed.cached === true ? 2 : c.parsed.cached === false ? 1 : 0);
export const better = (a: Candidate, b: Candidate) =>
  playability(a) !== playability(b) ? playability(a) > playability(b) : a.score !== b.score ? a.score > b.score : a.seq < b.seq;

export const compare = (a: Candidate, b: Candidate) => b.score - a.score || a.seq - b.seq;

export function makeCandidate(addon: string, stream: Stream, ctx: TitleContext, prefs: Prefs, seq: number, w: Weights = defaultWeights): Candidate {
  const parsed = parseStream(stream, { type: ctx.type, anime: ctx.kind === 'anime' });
  const verdict = judge(parsed, ctx);
  return {
    key: dedupKey(parsed) ?? `${addon}#${seq}`,
    addon,
    stream,
    parsed,
    verdict,
    score: scoreStream(parsed, verdict, ctx, prefs, w),
    tier: tierOf(parsed, verdict),
    alternates: [],
    seq,
  };
}
