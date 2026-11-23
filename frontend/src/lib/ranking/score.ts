import type { Stream } from "@/lib/addon-protocol";

import type { TitleContext } from "./context";
import { judge, mbps, type Verdict } from "./fakes";
import { parseStream, type Parsed, type Resolution } from "./parse";
import type { Remembered } from "./remembered";

// Scoring, quality tiers and cross-addon de-duplication (#51). Every weight
// is in `defaultWeights`, hand-set from #6 and tuned there; they aren't
// user-facing.

// What the user and the device allow.
export type Prefs = {
  // Preferred audio languages as ISO 639-1 codes, most preferred first; []
  // for no preference.
  languages: string[];
  maxResolution: Resolution;
  // The profile's preferred quality: streams above it rank just below it,
  // ahead of anything lower. null prefers the highest under the cap.
  preferredResolution?: Resolution | null;
  // The display shows HDR10, and Dolby Vision.
  hdr: boolean;
  dolbyVision: boolean;
  // The source the profile last played this show from (#58): its best
  // match is the top pick. It changes no score.
  remembered?: Remembered | null;
};

export const defaultPrefs: Prefs = {
  languages: [],
  maxResolution: "2160p",
  preferredResolution: null,
  hdr: false,
  dolbyVision: false,
};

// Cached on debrid first, then quality, then a plausible size. Each band is
// wide enough that a lower one can't overturn a higher one: a cached 720p
// beats an uncached 4K remux.
export const defaultWeights = {
  // Cached on the user's debrid service: plays at once.
  cached: 10_000,
  // Needs a download first.
  uncachedDebrid: 0,
  // P2P only: 1 seeder 0, 10 seeders 150, 1,000 seeders 450.
  p2pSeedersPerLog10: 150,
  p2pDeadSwarm: -2_000,
  resolution: {
    "2160p": 4_000,
    "1440p": 3_500,
    "1080p": 3_000,
    "720p": 2_000,
    "576p": 1_200,
    "480p": 1_000,
    "360p": 500,
    unknown: 1_500,
  },
  // Over the device's cap (#98): below everything that fits, cached or not.
  // The widest gap between a fitting stream and an over-cap one is the cached
  // bonus plus the best of the rest (about 17,000), against the worst fitting
  // score (about -9,000), so the penalty clears both.
  aboveMaxResolution: -30_000,
  // Above the profile's preferred quality: scored as the preferred one,
  // less this, so it follows the preferred streams but leads lower ones.
  abovePreferred: 250,
  source: {
    remux: 600,
    bluray: 500,
    "web-dl": 450,
    webrip: 350,
    hdtv: 200,
    dvd: 150,
    other: 100,
    unknown: 250,
    cam: 0,
    ts: 0,
    tc: 0,
    scr: 0,
  },
  // Only when the display shows it.
  hdrShown: { DV: 300, "HDR10+": 250, HDR10: 200 },
  // Dolby Vision with no HDR10 layer on a display without it: wrong colours.
  dvWithoutFallback: -800,
  audio: {
    truehd: 120,
    "dts-x": 120,
    "dts-hd": 100,
    lpcm: 100,
    flac: 80,
    eac3: 60,
    dts: 50,
    ac3: 40,
    opus: 30,
    aac: 20,
    mp3: 0,
    unknown: 20,
  },
  atmos: 40,
  videoCodec: { hevc: 40, av1: 40, avc: 20, vc1: 0, mpeg2: -50, xvid: -150, unknown: 0 },
  // log2(bitrate ÷ what the resolution needs) × this, clamped: a small nudge
  // inside a quality band, strongly negative only for starved encodes.
  sizePerDoubling: 60,
  sizeClamp: [-400, 120] as const,
  expectedMbps: {
    "2160p": 8,
    "1440p": 6,
    "1080p": 3,
    "720p": 1.5,
    "576p": 1,
    "480p": 0.8,
    "360p": 0.5,
    unknown: 1.5,
  },
  // The first preferred language present; later ones get a share.
  preferredLanguage: 1_500,
  // Languages are stated, none is preferred, and it isn't multi-audio. A
  // stream that states none is never penalized.
  otherLanguageOnly: -2_500,
  suspicious: -3_000,
};

export type Weights = typeof defaultWeights;

export type Tier = "4K" | "1080p" | "720p" | "SD" | "Unknown" | "Low quality" | "Likely fake";

// "Low quality" and "Likely fake" start collapsed.
export const tiers: readonly Tier[] = [
  "4K",
  "1080p",
  "720p",
  "SD",
  "Unknown",
  "Low quality",
  "Likely fake",
];
export const collapsedTiers: ReadonlySet<Tier> = new Set(["Low quality", "Likely fake"]);

// The order of the picker's groups. Those above the device's resolution cap
// (#98) follow the ones that fit, the nearest to the cap first, but stay ahead
// of the collapsed groups.
export function tierOrder(prefs: Prefs): readonly Tier[] {
  const cap = resolutionOrder.indexOf(prefs.maxResolution);
  const over = tiers.filter((tier) => {
    const lowest = tierLowest[tier];
    return lowest !== undefined && resolutionOrder.indexOf(lowest) > cap;
  });
  const ordered = over.length ? withoutOver(over) : tiers;

  // The preferred quality is soft, so the tiers above it that still fit the
  // cap follow its own tier, nearest first: a 1080p profile sees 4K right
  // under 1080p and ahead of 720p.
  const preferred = prefs.preferredResolution;
  if (!preferred) return ordered;
  const above = ordered
    .filter((tier) => {
      const lowest = tierLowest[tier];
      if (lowest === undefined) return false;
      const rank = resolutionOrder.indexOf(lowest);
      return rank > resolutionOrder.indexOf(preferred) && rank <= cap;
    })
    .sort(byTierResolution);
  const anchor = ordered.findIndex((tier) => tierLowest[tier] === preferred);
  if (!above.length || anchor < 0) return ordered;
  const rest = ordered.filter((tier) => !above.includes(tier));
  const at = rest.indexOf(ordered[anchor]!) + 1;
  return [...rest.slice(0, at), ...above, ...rest.slice(at)];
}

// The cap-ordered list: the tiers over the cap after the ones that fit, with
// the collapsed groups still last.
function withoutOver(over: readonly Tier[]): readonly Tier[] {
  const fits = tiers.filter((tier) => !over.includes(tier));
  const at = fits.findIndex((tier) => collapsedTiers.has(tier));
  return [...fits.slice(0, at), ...over.toReversed(), ...fits.slice(at)];
}

// Lowest resolution first: the tier nearest the preferred one comes first.
const byTierResolution = (a: Tier, b: Tier) =>
  resolutionOrder.indexOf(tierLowest[a]!) - resolutionOrder.indexOf(tierLowest[b]!);

// The smallest resolution a tier holds, for those that hold one.
const tierLowest: Partial<Record<Tier, Resolution>> = {
  "4K": "2160p",
  "1080p": "1080p",
  "720p": "720p",
};

function tierOf(p: Parsed, v: Verdict): Tier {
  if (v.bucket === "hidden") return "Likely fake";
  if (v.bucket === "low quality") return "Low quality";
  if (p.resolution === "2160p") return "4K";
  if (p.resolution === "1440p" || p.resolution === "1080p") return "1080p";
  if (p.resolution === "720p") return "720p";
  return p.resolution ? "SD" : "Unknown";
}

export const resolutionOrder: Resolution[] = [
  "360p",
  "480p",
  "576p",
  "720p",
  "1080p",
  "1440p",
  "2160p",
];

export function scoreStream(
  p: Parsed,
  v: Verdict,
  ctx: TitleContext,
  prefs: Prefs = defaultPrefs,
  w: Weights = defaultWeights,
): number {
  let s = 0;
  if (p.cached === true) s += w.cached;
  else if (p.cached === false) s += w.uncachedDebrid;
  else if (p.seeders !== null) {
    s += p.seeders === 0 ? w.p2pDeadSwarm : Math.log10(p.seeders) * w.p2pSeedersPerLog10;
  }

  const res = p.resolution ?? "unknown";
  const preferred = prefs.preferredResolution;
  if (
    preferred &&
    p.resolution &&
    resolutionOrder.indexOf(p.resolution) > resolutionOrder.indexOf(preferred)
  ) {
    // Above the profile's preferred quality: it scores as the preferred one
    // does, less `abovePreferred`, so it follows the preferred streams and
    // leads every lower one.
    s += w.resolution[preferred] - w.abovePreferred;
  } else {
    s += w.resolution[res];
  }
  if (
    p.resolution &&
    resolutionOrder.indexOf(p.resolution) > resolutionOrder.indexOf(prefs.maxResolution)
  ) {
    s += w.aboveMaxResolution;
  }
  s += w.source[p.source ?? "unknown"];

  const fallback = p.hdr.includes("HDR10") || p.hdr.includes("HDR10+");
  if (p.hdr.includes("DV") && !prefs.dolbyVision && !fallback) s += w.dvWithoutFallback;
  const shown = p.hdr.filter((h) => (h === "DV" ? prefs.dolbyVision : prefs.hdr));
  if (shown.length) s += Math.max(...shown.map((h) => w.hdrShown[h]));

  s += w.audio[p.audioCodec ?? "unknown"] + (p.atmos ? w.atmos : 0);
  s += w.videoCodec[p.videoCodec ?? "unknown"];

  const rate = mbps(p, ctx);
  if (rate !== null && rate > 0) {
    const doublings = Math.log2(rate / w.expectedMbps[res]) * w.sizePerDoubling;
    s += Math.min(w.sizeClamp[1], Math.max(w.sizeClamp[0], doublings));
  }

  if (prefs.languages.length && p.languages.length) {
    const hit = prefs.languages.findIndex((language) => p.languages.includes(language));
    if (hit >= 0) s += w.preferredLanguage / (hit + 1);
    else if (!p.languages.includes("multi")) s += w.otherLanguageOnly;
  }
  if (v.bucket === "suspicious") s += w.suspicious;
  return Math.round(s);
}

// --- De-duplication -----------------------------------------------------------

const normName = (name: string) =>
  name
    .toLowerCase()
    .replace(/\.[a-z0-9]{2,4}$/, "")
    .replace(/[^a-z0-9]+/g, "");

// Same torrent and same file: the file by name when known, else by index
// (Torrentio P2P); the bare hash covers single-file torrents.
export function dedupKey(p: Parsed): string | null {
  if (!p.infoHash) return null;
  if (p.fileName) return `${p.infoHash}:${normName(p.fileName)}`;
  if (p.fileIdx !== null) return `${p.infoHash}:#${p.fileIdx}`;
  return p.infoHash;
}

// Same file name with a size within 1%: the same file in another torrent.
export function fileKey(p: Parsed): string | null {
  if (!p.fileName || !p.sizeBytes || !/\.[a-z0-9]{2,4}$/i.test(p.fileName)) return null;
  return `${normName(p.fileName)}:${Math.round(Math.log(p.sizeBytes) / Math.log(1.01))}`;
}

// --- Candidates ---------------------------------------------------------------

// Another copy of a candidate's file: from another addon, or another torrent.
export type Alternate = { source: string; seq: number; stream: Stream };

// One stream as ranked. `source` is the addon's URL (or a plugin's id);
// `seq` is the order it arrived in, the last tie-break, so the order is
// stable. `alternates` are kept as fallbacks if it fails to resolve.
export type Candidate = {
  key: string;
  source: string;
  seq: number;
  stream: Stream;
  parsed: Parsed;
  verdict: Verdict;
  score: number;
  tier: Tier;
  alternates: Alternate[];
};

// What plays soonest: cached debrid, then uncached debrid, then P2P.
const playability = (c: Candidate) =>
  c.parsed.cached === true ? 2 : c.parsed.cached === false ? 1 : 0;

// Which copy of a file to keep: the one that plays soonest, then the higher
// score, then the earlier.
export function better(a: Candidate, b: Candidate): boolean {
  if (playability(a) !== playability(b)) return playability(a) > playability(b);
  if (a.score !== b.score) return a.score > b.score;
  return a.seq < b.seq;
}

export const compare = (a: Candidate, b: Candidate) => b.score - a.score || a.seq - b.seq;

export function candidate(
  source: string,
  stream: Stream,
  seq: number,
  ctx: TitleContext,
  prefs: Prefs = defaultPrefs,
  w: Weights = defaultWeights,
): Candidate {
  const parsed = parseStream(stream, { type: ctx.type, anime: ctx.anime });
  const verdict = judge(parsed, ctx);
  return {
    key: dedupKey(parsed) ?? `${source}#${seq}`,
    source,
    seq,
    stream,
    parsed,
    verdict,
    score: scoreStream(parsed, verdict, ctx, prefs, w),
    tier: tierOf(parsed, verdict),
    alternates: [],
  };
}
