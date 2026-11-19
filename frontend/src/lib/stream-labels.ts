import type {
  AudioCodec,
  Candidate,
  Debrid,
  Parsed,
  Reason,
  Resolution,
  Source,
  VideoCodec,
  Tier,
} from "@/lib/ranking";

// What the stream picker (#52) shows of a ranked stream, so nobody has to
// read its file name: short labels for each badge, from what the ranking
// engine parsed (#51). Everything is null or empty when the stream doesn't
// say. Never from the stream's URL, which can carry a debrid key.

const resolutions: Record<Resolution, string> = {
  "2160p": "4K",
  "1440p": "1440p",
  "1080p": "1080p",
  "720p": "720p",
  "576p": "576p",
  "480p": "480p",
  "360p": "360p",
};

const audioCodecs: Record<AudioCodec, string> = {
  truehd: "TrueHD",
  "dts-x": "DTS:X",
  "dts-hd": "DTS-HD",
  lpcm: "LPCM",
  flac: "FLAC",
  eac3: "DD+",
  dts: "DTS",
  ac3: "DD",
  opus: "Opus",
  aac: "AAC",
  mp3: "MP3",
};

const sources: Record<Source, string | null> = {
  remux: "Remux",
  bluray: "Blu-ray",
  "web-dl": "WEB-DL",
  webrip: "WEBRip",
  hdtv: "HDTV",
  dvd: "DVD",
  cam: "CAM",
  ts: "TS",
  tc: "TC",
  scr: "Screener",
  other: null,
};

export const debridNames: Record<Debrid, string> = {
  TB: "TorBox",
  RD: "Real-Debrid",
  AD: "AllDebrid",
  PM: "Premiumize",
  DL: "Debrid-Link",
  ED: "EasyDebrid",
  OC: "Offcloud",
  PP: "PikPak",
};

// Why a stream ranks low or sits in a collapsed group, for the user.
const reasons: Record<Reason, string> = {
  "non-video file": "Not a video file",
  extras: "Sample or extras",
  "wrong episode": "Another episode",
  "wrong season": "Another season",
  "episode for a movie": "An episode, not the film",
  "wrong year": "Another year’s release",
  "too small": "Too small for the runtime",
  // Reported, but it moves nothing until titles are translated (#99).
  "title mismatch": "",
  "too large": "Larger than its source allows",
  "cam / ts": "Filmed in a cinema",
};

export const resolutionLabel = (p: Parsed) => (p.resolution ? resolutions[p.resolution] : null);

// "TrueHD 7.1", "DD+ 5.1", "AAC", or the channels alone.
export function audioLabel(p: Parsed): string | null {
  const parts = [p.audioCodec && audioCodecs[p.audioCodec], p.channels].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

export const sourceLabel = (p: Parsed) => (p.source ? sources[p.source] : null);

const sizeFormat = new Intl.NumberFormat("en", { maximumFractionDigits: 1 });

// Decimal units, as addons and file managers show them.
export function sizeLabel(bytes: number | null): string | null {
  if (!bytes || bytes <= 0) return null;
  if (bytes >= 1e12) return `${sizeFormat.format(bytes / 1e12)} TB`;
  if (bytes >= 1e9) return `${sizeFormat.format(bytes / 1e9)} GB`;
  return `${sizeFormat.format(Math.max(bytes / 1e6, 0.1))} MB`;
}

// How it plays: cached on a debrid service (at once), on one but not cached
// (it downloads first), or peer to peer.
export type Delivery =
  | { kind: "cached"; label: string }
  | { kind: "uncached"; label: string }
  | { kind: "p2p"; label: string }
  | null;

export function delivery(p: Parsed): Delivery {
  const service = p.debrid ? debridNames[p.debrid] : null;
  if (p.cached === true)
    return { kind: "cached", label: service ? `Cached · ${service}` : "Cached" };
  if (p.cached === false) {
    return { kind: "uncached", label: service ? `Not cached · ${service}` : "Not cached" };
  }
  if (p.infoHash) {
    const peers =
      p.seeders === null ? "" : p.seeders === 1 ? " · 1 seeder" : ` · ${p.seeders} seeders`;
    return { kind: "p2p", label: `P2P${peers}` };
  }
  return null;
}

// Audio languages, up to three: "EN", "Multi", "EN · FR · +2".
export function languagesLabel(p: Parsed): string | null {
  if (p.languages.length === 0) return null;
  const named = p.languages.map((code) => (code === "multi" ? "Multi" : code.toUpperCase()));
  const shown = named.slice(0, 3);
  if (named.length > 3) shown.push(`+${named.length - 3}`);
  return shown.join(" · ");
}

export function reasonsLabel(c: Candidate): string | null {
  const said = c.verdict.reasons.map((reason) => reasons[reason]).filter(Boolean);
  return said.length ? said.join(" · ") : null;
}

// A group's heading.
export const tierLabel = (tier: Tier) => (tier === "Low quality" ? "Low quality (CAM / TS)" : tier);

// The raw names, for when the user asks: the file that plays (with its
// folders, when known), then the release names it came from. The parser
// lists the file first, with glued tokens split, so it's swapped for the
// file name as the addon sent it.
export const rawNames = (p: Parsed): string[] =>
  p.fileName ? [p.fileName, ...p.releaseNames.slice(1)] : [...p.releaseNames];

// "Pack · 48 GB" for a season pack: its size covers more than the episode
// that plays, so a bare size would read as one huge file.
export function sizeText(p: Parsed): string | null {
  const size = sizeLabel(p.sizeBytes);
  return size && p.pack ? `Pack · ${size}` : size;
}

const videoCodecs: Partial<Record<VideoCodec, string>> = {
  hevc: "HEVC",
  av1: "AV1",
  avc: "H.264",
};

// HEVC, AV1 or H.264, when the name says. Older codecs aren't badged.
export const videoCodecLabel = (p: Parsed): string | null =>
  p.videoCodec ? (videoCodecs[p.videoCodec] ?? null) : null;

// An estimate of the bitrate, size over runtime: "12 Mbps". Never for a
// pack, whose size isn't one video's, nor without both numbers.
export function bitrateLabel(p: Parsed, minutes: number | null): string | null {
  if (p.pack || !p.sizeBytes || p.sizeBytes <= 0 || !minutes || minutes <= 0) return null;
  const mbps = (p.sizeBytes * 8) / (minutes * 60) / 1e6;
  if (!Number.isFinite(mbps) || mbps <= 0) return null;
  return `~${mbps >= 10 ? Math.round(mbps) : sizeFormat.format(mbps)} Mbps`;
}
