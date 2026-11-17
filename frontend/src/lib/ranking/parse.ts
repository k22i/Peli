import type { Stream } from "@/lib/addon-protocol";

// The stream parser (#51): one addon stream → what it claims to be. Pure
// functions, no I/O.
//
// Addons put the same facts in different places (#6), so the parser first
// splits a stream into named pieces (file name, release names, size line,
// language line, cache marker), then reads each field from the most specific
// piece that has it: the file that plays, then the torrent or release name,
// then the addon's own `name`. Every field is null or empty when the stream
// doesn't say.

export type Resolution = "2160p" | "1440p" | "1080p" | "720p" | "576p" | "480p" | "360p";
export type Hdr = "DV" | "HDR10+" | "HDR10";
export type VideoCodec = "hevc" | "avc" | "av1" | "xvid" | "mpeg2" | "vc1";
export type AudioCodec =
  | "truehd"
  | "dts-x"
  | "dts-hd"
  | "lpcm"
  | "flac"
  | "eac3"
  | "dts"
  | "ac3"
  | "opus"
  | "aac"
  | "mp3";
export type Channels = "7.1" | "5.1" | "2.0" | "1.0";
export type Source =
  | "remux"
  | "bluray"
  | "web-dl"
  | "webrip"
  | "hdtv"
  | "dvd"
  | "cam"
  | "ts"
  | "tc"
  | "scr"
  | "other";

// A debrid service, by the short code addons put in a stream's name.
export type Debrid = "TB" | "RD" | "AD" | "PM" | "DL" | "ED" | "OC" | "PP";

export type Parsed = {
  resolution: Resolution | null;
  hdr: Hdr[];
  videoCodec: VideoCodec | null;
  audioCodec: AudioCodec | null;
  channels: Channels | null;
  atmos: boolean;
  sizeBytes: number | null;
  source: Source | null;
  group: string | null;
  // Audio languages as ISO 639-1 codes, plus "multi".
  languages: string[];
  season: number | null;
  episode: number | null;
  // The size covers more than the one video that plays.
  pack: boolean;
  year: number | null;
  // Cached on the debrid service: plays at once. null for P2P.
  cached: boolean | null;
  debrid: Debrid | null;
  infoHash: string | null;
  fileIdx: number | null;
  // The file that plays, when known.
  fileName: string | null;
  // Most specific first.
  releaseNames: string[];
  extension: string | null;
  seeders: number | null;
  // Sample, featurette, soundtrack or other bonus material.
  extras: boolean;
};

export type ParseHints = { type?: "movie" | "series"; anime?: boolean };

// --- Splitting the stream into pieces -----------------------------------------

const metaLine = /👤|💾|⚙️|🔎|🌐|📅/u;
const flag = /[\u{1F1E6}-\u{1F1FF}]{2}/u;
const flags = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const cometTagLine = /^(📹|🔊|⭐|🏷️)/u;
const videoExt = /^(mkv|mp4|avi|m4v|ts|m2ts|webm|mov|wmv|mpg|mpeg|flv|vob|iso|divx|ogm|rmvb)$/i;
const otherExt = /^(zip|rar|7z|exe|txt|nfo|srt|ass|mp3|flac|m4a|pdf|jpg|png|lnk|scr|bat)$/;
const anyExt = /\.([a-z0-9]{2,4})$/i;

type Pieces = {
  name: string;
  // The playing file's base name, and its path when the text gives folders.
  file: string | null;
  filePath: string | null;
  // The file first, then its folders, then the torrent names.
  releases: string[];
  meta: string;
  langLine: string;
  cometTags: string;
};

function pieces(s: Stream): Pieces {
  const name = (s.name ?? "").replace(/\s+/g, " ").trim();
  const text = s.description ?? s.title ?? "";
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const releases: string[] = [];
  let meta = "";
  let langLine = "";
  let cometTags = "";
  for (const line of lines) {
    if (line.startsWith("📄")) releases.push(line.replace(/^📄\s*/u, ""));
    else if (cometTagLine.test(line)) cometTags += " " + line;
    else if (metaLine.test(line)) meta += " " + line;
    else if (flag.test(line) || /^(🌎|Multi Audio|Dual Audio|Dubbed|Multi Subs)/u.test(line)) {
      langLine += " " + line;
    } else releases.push(line);
  }
  const hinted = s.behaviorHints?.filename ?? null;
  // A second release line ending in an extension is the file inside a pack
  // (Torrentio, TorrentsDB, Peerflix); it may carry folders.
  let filePath: string | null = null;
  for (const release of releases.slice(1)) if (anyExt.test(release)) filePath = release;
  const only = releases.length === 1 ? releases[0]! : null;
  if (!filePath && only && anyExt.test(only) && !hinted) filePath = only;
  if (!filePath && hinted) filePath = hinted;
  const file = filePath ? filePath.split("/").pop()! : null;
  // Folders matter: "…(1080p BluRay x265 EAC3 5.1 Silence)/S03/Featurettes/…".
  const ordered: string[] = [];
  if (file) ordered.push(file);
  if (filePath && filePath !== file) ordered.push(filePath);
  if (hinted && !ordered.includes(hinted)) ordered.push(hinted);
  for (const release of releases.toReversed()) {
    if (!ordered.includes(release)) ordered.push(release);
  }
  return { name, file, filePath, releases: ordered.map(unglue), meta, langLine, cometTags };
}

// Some names glue tokens together: "HDR10x265", "DoVi HDR10x265-SM737".
const unglue = (text: string) => text.replace(/(hdr10\+?|hdr)(x26[45])/gi, "$1 $2");

// --- Field readers ------------------------------------------------------------

function first<T>(texts: readonly string[], read: (text: string) => T | null): T | null {
  for (const text of texts) {
    const value = read(text);
    if (value !== null) return value;
  }
  return null;
}

const resolutions: Partial<Record<string, Resolution>> = {
  "2160": "2160p",
  "1440": "1440p",
  "1080": "1080p",
  "720": "720p",
  "576": "576p",
  "480": "480p",
  "360": "360p",
};
const asResolution = (digits: string | undefined) => (digits && resolutions[digits]) || null;

export function readResolution(text: string): Resolution | null {
  // Bare numbers ("1080") count only with a p or i, or inside a WxH pair.
  const suffixed = text.match(
    /(?:^|[^a-z0-9])(?:m|bd|micro-?)?(2160|1440|1080|720|576|480|360)[pi](?![a-z0-9])/i,
  );
  if (suffixed) return asResolution(suffixed[1]);
  const wxh = text.match(/\b\d{3,4}\s?[x×]\s?(2160|1440|1080|720|576|480|360)\b/i);
  if (wxh) return asResolution(wxh[1]);
  if (/\b19[12]\dx10[0-9]{2}\b/.test(text)) return "1080p";
  if (/(?:^|[^a-z0-9])(4k|uhd)(?![a-z0-9])/i.test(text) && !/tone-?mapped/i.test(text)) {
    return "2160p";
  }
  return null;
}

function readHdr(text: string): Hdr[] {
  const out = new Set<Hdr>();
  if (/(?:^|[^a-z0-9])(dv|dovi|dolby[ ._-]?vision|dvp\d)(?![a-z0-9])/i.test(text)) out.add("DV");
  if (/hdr10(\+|plus|p\b)/i.test(text)) out.add("HDR10+");
  const generic =
    /(?:^|[^a-z0-9])(hdr|hdr10|hlg)(?![a-z0-9+]|plus)/i.test(text) &&
    !/hdr[ ._-]?tone-?mapped/i.test(text);
  if (generic && !out.has("HDR10+")) out.add("HDR10");
  return [...out];
}

const videoCodecs: [VideoCodec, RegExp][] = [
  ["hevc", /(?:^|[^a-z0-9])(x\.?265|h[ .]?265|hevc)(?![a-z0-9])/i],
  ["avc", /(?:^|[^a-z0-9])(x\.?264|h[ .]?264|avc)(?![a-z0-9])/i],
  ["av1", /(?:^|[^a-z0-9])av1(?![a-z0-9])/i],
  ["xvid", /(?:^|[^a-z0-9])(xvid|divx)(?![a-z0-9])/i],
  ["mpeg2", /(?:^|[^a-z0-9])mpeg-?2?(?![a-z0-9])/i],
  ["vc1", /(?:^|[^a-z0-9])vc-?1(?![a-z0-9])/i],
];

// The first codec named wins: the earliest token is usually the video track.
function readVideoCodec(text: string): VideoCodec | null {
  let best: { codec: VideoCodec; at: number } | null = null;
  for (const [codec, re] of videoCodecs) {
    const match = re.exec(text);
    if (match && (!best || match.index < best.at)) best = { codec, at: match.index };
  }
  return best?.codec ?? null;
}

// Best first.
const audioCodecs: [AudioCodec, RegExp][] = [
  ["truehd", /true[ ._-]?hd/i],
  ["dts-x", /(?:^|[^a-z0-9])dts[ ._:-]?x(?![a-z0-9])/i],
  ["dts-hd", /dts[ ._-]?hd|(?:^|[^a-z0-9])dts[ ._-]?ma(?![a-z0-9])|dts lossless/i],
  ["lpcm", /(?:^|[^a-z0-9])l?pcm(?![a-z0-9])/i],
  ["flac", /(?:^|[^a-z0-9])flac(?![a-z])/i],
  ["eac3", /(?:^|[^a-z0-9])(e-?ac-?3|ddpa?|dd\+|dolby digital plus)(?![a-z])/i],
  ["dts", /(?:^|[^a-z0-9])dts(?![a-z])/i],
  ["ac3", /(?:^|[^a-z0-9])(ac-?3|dd|dolbyd)(?![a-z+])|dolby digital(?! plus)/i],
  ["opus", /(?:^|[^a-z0-9])opus(?![a-z])/i],
  ["aac", /(?:^|[^a-z0-9])aac(?![a-z])/i],
  ["mp3", /(?:^|[^a-z0-9])mp3(?![a-z])/i],
];

// The best track named anywhere.
const readAudio = (text: string): AudioCodec | null =>
  audioCodecs.find(([, re]) => re.test(text))?.[0] ?? null;

// By a layout's first digit ("5.1", "5 1"), or a channel count ("6ch").
const channelNames: Partial<Record<string, Channels>> = {
  "7": "7.1",
  "5": "5.1",
  "2": "2.0",
  "1": "1.0",
  "8ch": "7.1",
  "6ch": "5.1",
  "2ch": "2.0",
  "1ch": "1.0",
};

function readChannels(text: string): Channels | null {
  const layout = text.match(/(?<!\d)(7[ .]1|5[ .]1|2[ .]0|1[ .]0)(?!\d)/)?.[1];
  if (layout) return channelNames[layout.charAt(0)] ?? null;
  const count = text.match(/(?:^|[^a-z0-9])([1268])\s?ch(?![a-z])/i)?.[1];
  return count ? (channelNames[`${count}ch`] ?? null) : null;
}

// Worst first: one CAM tag outweighs a "1080p WEB" claim.
const sources: [Source, RegExp][] = [
  ["cam", /(?:^|[^a-z0-9])(hd-?)?cam(-?rip)?(?![a-z0-9])/i],
  ["ts", /(?:^|[^a-z0-9])(hd-?ts|tele-?sync|ts-?rip|pdvd)(?![a-z0-9])|\[ts\]/i],
  ["tc", /(?:^|[^a-z0-9])(hd-?tc|tele-?cine)(?![a-z0-9])/i],
  ["scr", /(?:^|[^a-z0-9])(screener|dvd-?scr|bd-?scr|web-?scr|ts-?screener|scr)(?![a-z0-9])/i],
  ["remux", /remux/i],
  ["webrip", /(?:^|[^a-z0-9])(web-?(dl)?-?rip|netflix-?rip|amazon-?rip)(?![a-z0-9])/i],
  ["web-dl", /(?:^|[^a-z0-9])(web-?dl|web)(?![a-z0-9])/i],
  [
    "bluray",
    /(?:^|[^a-z0-9])(?:(full-?blu-?ray|blu-?ray|bd-?rip|br-?rip|bdmux|bd)(?![a-z0-9])|bd(?=\d{3,4}p))|bluray rip/i,
  ],
  ["hdtv", /(?:^|[^a-z0-9])hdtv(-?rip)?(?![a-z0-9])/i],
  ["dvd", /(?:^|[^a-z0-9])dvd(-?rip|r|5|9)?(?![a-z0-9])/i],
  ["other", /(?:^|[^a-z0-9])(dcp(-?rip)?|hd-?rip|vhs-?rip|tv-?rip|sat-?rip)(?![a-z0-9])/i],
];

const readSource = (text: string): Source | null =>
  sources.find(([, re]) => re.test(text))?.[0] ?? null;

// --- Release group ------------------------------------------------------------

const notGroup = new Set([
  "x264",
  "x265",
  "h264",
  "h265",
  "hevc",
  "avc",
  "av1",
  "aac",
  "ac3",
  "eac3",
  "dts",
  "ddp",
  "dd",
  "flac",
  "opus",
  "mp3",
  "web",
  "webdl",
  "webrip",
  "bluray",
  "bdrip",
  "brrip",
  "hdtv",
  "dl",
  "rip",
  "remux",
  "hdr",
  "sdr",
  "dv",
  "dual",
  "multi",
  "lat",
  "latino",
  "eng",
  "ita",
  "spa",
  "esp",
  "fre",
  "ger",
  "jap",
  "kor",
  "rus",
  "hin",
  "1080p",
  "720p",
  "2160p",
  "480p",
  "4k",
  "uhd",
  "mkv",
  "mp4",
  "avi",
  "sub",
  "subs",
  "esub",
  "msubs",
  "repack",
  "proper",
  "internal",
  "final",
  "complete",
  "batch",
  "raw",
  "raws",
  "hd",
]);
const siteLike =
  /(www\.|\.(com|org|net|io|to|tv|cc|pm|in|me|nl|tax|ws|mx|lt|am|ag|se)\b|eztv|tgx|rartv|nnmclub|rutracker)/i;
// Tokens that describe the encode. A release group follows them; title words
// don't.
const techToken =
  /^(x26[45]|h\.?26[45]|26[45]|dl|\d+(\.\d+)?[gm]i?b|hevc|avc|av1|xvid|divx|aac\d?(\.\d)?|e?ac3|ddp?a?(\d(\.\d)?)?|dts(-?hd)?|truehd|atmos|flac|opus|\d{3,4}[pi]|4k|uhd|hdr(10)?(\+|plus)?|sdr|dv|10-?bits?|blu-?ray|bdrip|brrip|bd|web(-?dl|rip)?|webdl|dlrip|hdtv|remux|hdrip|dcp(rip)?|\d\.\d|\dch|mkv|mp4)$/i;
const langOrSub =
  /^(cz|czsub|sub|subs|esub|msubs|eng|ita|spa|esp|lat|latino|dual|multi|es|en|fr|ru|pl|vostfr|castellano|es-en|br)$/i;
const hasTech = (text: string) => text.split(/[\s._\-[\]()]+/).some((part) => techToken.test(part));

function validGroup(raw: string | undefined): string | null {
  if (!raw) return null;
  const group = raw
    .trim()
    .replace(/^[[(]|[\])]$/g, "")
    .replace(/[^\p{L}\p{N}_.-]+$/u, "")
    .trim();
  // One letter, or no letters at all ("264_202609"), isn't a group.
  if (group.length < 2 || group.length > 32 || !/\p{L}/u.test(group)) return null;
  if (notGroup.has(group.toLowerCase()) || langOrSub.test(group) || techToken.test(group)) {
    return null;
  }
  if (/^\d+$/.test(group) || /^[0-9a-f]{8}$/i.test(group)) return null;
  if (/^(s\d|e\d|\d{3,4}p|cap\.?\s?\d|temporada|season)/i.test(group)) return null;
  return group;
}

// One hyphen segment as a group: "MeGusta", "YTS.MX", "MeM.GP",
// "BYNDR.CZsub" → "BYNDR", "Pahe.in" → "Pahe", "PSOTNIK HT" → "PSOTNIK".
// Segments with encode tokens are title or tech, not a group.
function groupFromSegment(segment: string): string | null {
  let group = segment
    .trim()
    .replace(/^\[|\]$/g, "")
    .trim();
  // A second tag after a space: "FLUX-PSOTNIK HT".
  const tagged = group.match(/^([A-Za-z][A-Za-z0-9]+) [A-Z]{2,3}$/);
  if (tagged) group = tagged[1]!;
  if (!group || /\s/.test(group) || hasTech(group)) return null;
  if (/^YTS\.[A-Z]{2}$/i.test(group)) return group;
  const parts = group.split(".");
  while (parts.length > 1 && langOrSub.test(parts.at(-1)!)) parts.pop();
  group = parts.join(".");
  if (/^www\./i.test(group)) return null;
  if (siteLike.test(group)) group = group.replace(/\.[a-z]{2,3}$/i, "");
  return validGroup(group);
}

function readGroup(text: string): string | null {
  const base = text.replace(anyExt, "").trim();
  const raws = base.match(/(?:^|[\s[(-])([A-Za-z0-9]+-Raws)(?![A-Za-z])/i);
  if (raws) return raws[1]!;
  // [Group] at the start, as anime fansubs do. Not site tags or CJK tags.
  const lead = base.match(/^\[([^\]]+)\]/)?.[1];
  if (lead && !siteLike.test(lead) && !/[　-鿿]/.test(lead)) {
    const group = validGroup(lead);
    if (group) return group;
  }
  // -GROUP at the end, once trailing [site] and (hash) tags are off, but only
  // when an encode token comes before it: "The Amazing Spider-Man" has none.
  const stripped = base.replace(/(\s*[[(][^\])]*[\])])+\s*$/g, "");
  const segments = stripped.split("-");
  for (let i = segments.length - 1; i >= Math.max(1, segments.length - 2); i--) {
    const segment = segments[i]!.trim();
    // "-HEVC-PSA-CZ", "1080P-Dual-Lat"
    if (langOrSub.test(segment)) continue;
    const group = groupFromSegment(segment);
    if (group && hasTech(segments.slice(0, i).join("-"))) return group;
    break;
  }
  // "… x264.seleZen", "… ac3 mHDgz", "… HDR.NEWCOMERS": a last word right after
  // an encode token. "… Subs KINGDOM", "… sub ita eng Licdom": after subtitle
  // words that follow one.
  const words = stripped.split(/[\s.]+/).filter(Boolean);
  const last = words.at(-1);
  let before = words.length - 2;
  while (before > 0 && langOrSub.test(words[before]!)) before--;
  // "DDP5.1" is split in two.
  const tech =
    techToken.test(words[before]!) || techToken.test(words.slice(before - 1, before + 1).join("."));
  const lastWord = last?.replace(/[^\p{L}\p{N}_]+$/u, "");
  if (lastWord && words.length > 2 && tech && /^[A-Za-z][A-Za-z0-9_]{1,}$/.test(lastWord)) {
    const group = validGroup(lastWord);
    if (group) return group;
  }
  // "(1080p BluRay x265 HEVC 10bit AAC 5.1 Joy)": an encoder tag at the end of
  // a tech group, QxR style.
  const qxr = base.match(/\(([^()]*)\s([A-Za-z][A-Za-z0-9]{1,15})\)/);
  if (qxr && hasTech(qxr[1]!)) {
    const group = validGroup(qxr[2]);
    if (group) return group;
  }
  // "by Me7alh", "by.AKTEP", "от Kerob"
  const by = base.match(/(?:^|[\s.])(?:by[\s.]?|от\s)([A-Za-z][A-Za-z0-9_]{2,})(?:\s|\.|$)/);
  if (by) return validGroup(by[1]);
  // A trailing [Group]: "[Prof]", "[QxR]".
  const trailing = base.match(/\[([A-Za-z][A-Za-z0-9]{1,15})\]\s*$/)?.[1];
  if (trailing && !siteLike.test(trailing)) return validGroup(trailing);
  return null;
}

// --- Languages ----------------------------------------------------------------

const flagLanguages: Record<string, string> = {
  GB: "en",
  US: "en",
  JP: "ja",
  IT: "it",
  PT: "pt",
  BR: "pt",
  ES: "es",
  MX: "es",
  FR: "fr",
  DE: "de",
  NL: "nl",
  PL: "pl",
  CZ: "cs",
  HU: "hu",
  BG: "bg",
  RS: "sr",
  HR: "hr",
  DK: "da",
  SE: "sv",
  NO: "no",
  TR: "tr",
  IL: "he",
  VN: "vi",
  ID: "id",
  MY: "ms",
  TH: "th",
  KR: "ko",
  CN: "zh",
  TW: "zh",
  HK: "zh",
  IN: "hi",
  SA: "ar",
  RU: "ru",
  UA: "uk",
  LT: "lt",
  LV: "lv",
  EE: "et",
  GR: "el",
  RO: "ro",
  FI: "fi",
  SK: "sk",
  SI: "sl",
  IR: "fa",
  AZ: "az",
};

const languageWords: [string, RegExp][] = [
  ["en", /(?:^|[^a-z])(eng|english|inglés|ingles)(?![a-z])|(?:^|[^A-Za-z])EN(?![A-Za-z])/i],
  ["it", /(?:^|[^a-z])(ita|italian)(?![a-z])/i],
  [
    "es",
    /(?:^|[^a-z])(spa|esp|spanish|castellano|latino|lat|español)(?![a-z])|(?:^|[^A-Za-z])ES(?![A-Za-z])/i,
  ],
  ["fr", /(?:^|[^a-z])(french|truefrench|vff|vfq|vf2|vfi)(?![a-z])|(?:^|[^A-Za-z])FR(?![A-Za-z])/i],
  ["de", /(?:^|[^a-z])(german|deutsch|ger)(?![a-z])/i],
  ["ja", /(?:^|[^a-z])(jap|jpn|japanese)(?![a-z])/i],
  ["ko", /(?:^|[^a-z])(kor|korean|coreano)(?![a-z])/i],
  ["ru", /(?:^|[^a-z])(rus|russian)(?![a-z])/i],
  ["hi", /(?:^|[^a-z])(hin|hindi)(?![a-z])/i],
  ["ta", /(?:^|[^a-z])(tam|tamil)(?![a-z])/i],
  ["te", /(?:^|[^a-z])(tel|telugu|telegu)(?![a-z])/i],
  ["kn", /(?:^|[^a-z])(kan|kannada)(?![a-z])/i],
  ["pt", /(?:^|[^a-z])(pt-?br|ptbr|dublado|portuguese)(?![a-z])/i],
  ["pl", /(?:^|[^A-Za-z])PL(?![A-Za-z])|(?:^|[^a-z])(polish|lektor)(?![a-z])/i],
  ["cs", /(?:^|[^A-Za-z])CZ(?![A-Za-z])|(?:^|[^a-z])czech(?![a-z])/i],
  ["hu", /(?:^|[^a-z])(hun|hungarian)(?![a-z])/i],
  ["lt", /(?:^|[^A-Za-z.])LT(?![A-Za-z])/],
  ["uk", /(?:^|[^a-z])(ukr|ukrainian)(?![a-z])/i],
  ["az", /(?:^|[^a-z])azerbaijan/i],
  ["zh", /mandarin|cantonese|国语|國語|粤语|粵語/i],
];

// "Multi Subs" means every flag is a subtitle language. These each name one
// subtitle language.
const allFlagsAreSubs = /multi[ -]?subs?|multiple subtitle/i;
const subtitleLanguages: [RegExp, string][] = [
  [/legendado/i, "pt"],
  [/subtitulado|vose/i, "es"],
  [/vostfr/i, "fr"],
  [/subs?[ ._-]?pt-?br/i, "pt"],
];
// Three or more bracketed language tags in a row are a subtitle list, as
// Erai-raws name them: "[ENG][POR-BR][SPA-LA][SPA][ARA]…".
const subtitleList = /(\[[A-Z]{2,3}(-[A-Z]{2})?\]\s*){3,}/g;

function readLanguages(p: Pieces, group: string | null, extra: unknown, anime: boolean): string[] {
  const out = new Set<string>();
  const names = p.releases.join(" | ").replace(subtitleList, " ");
  const text = group ? names.split(group).join(" ") : names;
  // "sub ita.eng", "ESub" and "Eng Sub" are subtitles; "DOBLADA EN
  // CASTELLANO" is Spanish, not English.
  const cleaned = text
    .replace(/multi[ -]?subs?|(eng|ita|spa)[ ._-]+subs?/gi, " ")
    .replace(
      /(e?subs?|subtitles?)[ ._-]*(ita|eng|spa|rus|ukr|fr|cz|pt-?br)?([ ._-]*(ita|eng|spa|rus|ukr))*/gi,
      " ",
    )
    .replace(/(?:^|[^a-z])en[ ._](castellano|español|espanol)/gi, " $1");
  for (const [code, re] of languageWords) if (re.test(cleaned)) out.add(code);
  const multi =
    /(?:^|[^a-z])(multi|dual|daul)(?![a-z])(?![ -]?subs?)|multi[ -]?audio|dual[ -]?audio|multi\d/i.test(
      cleaned,
    ) || /multi audio|dual audio/i.test(p.langLine);
  if (multi) out.add("multi");
  if (multi && anime && /dual[ -]?audio/i.test(names + p.langLine)) {
    out.add("ja");
    out.add("en");
  }
  // German.DL: German plus the original language.
  if (/german[ ._-]+(dubbed[ ._-]+)?dl(?![a-z])/i.test(cleaned)) {
    out.add("de");
    out.add(anime ? "ja" : "en");
  }
  if (!allFlagsAreSubs.test(p.langLine + " " + names)) {
    for (const pair of p.langLine.match(flags) ?? []) {
      // Two regional indicators, each a surrogate pair.
      const country = [0, 2]
        .map((at) => String.fromCodePoint(pair.codePointAt(at)! - 0x1f1e6 + 65))
        .join("");
      const code = flagLanguages[country];
      if (code) out.add(code);
    }
  }
  // Peerflix sends the release's language as a top-level field.
  if (typeof extra === "string" && /^[a-z]{2}$/.test(extra)) out.add(extra);
  for (const [re, code] of subtitleLanguages) if (re.test(names)) out.delete(code);
  return [...out];
}

// --- Season and episode -------------------------------------------------------

type SeasonEpisode = { season: number | null; episode: number | null; range: boolean };

const num = (digits: string | undefined) => Number(digits);

function readSeasonEpisode(text: string, type: ParseHints["type"]): SeasonEpisode | null {
  let m = text.match(
    /(?:^|[^a-z0-9])s(\d{1,2})\s*[-._ ]?\s*e(\d{1,4}(?:\.5)?)(?:\s*-\s*e?(\d{1,4}))?/i,
  );
  if (m) return { season: num(m[1]), episode: m[3] ? null : num(m[2]), range: !!m[3] };
  m = text.match(/(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?:\s*-\s*(\d{1,3}))?(?![0-9])/i);
  if (m && num(m[1]) < 40) {
    return { season: num(m[1]), episode: m[3] ? null : num(m[2]), range: !!m[3] };
  }
  m = text.match(/cap\.?\s?(\d{1,2})(\d{2})(?:[_-](\d{1,2})(\d{2}))?(?![0-9])/i);
  if (m) return { season: num(m[1]), episode: m[3] ? null : num(m[2]), range: !!m[3] };
  m = text.match(/(?:^|[^a-z0-9])e(\d{2,4})\s*-\s*e?(\d{2,4})(?![0-9])/i);
  if (m) return { season: null, episode: null, range: true };
  // "S1 - 01", "Season 2 - 05": a season, then a bare episode number.
  m = text.match(/(?:^|[^a-z0-9])(?:s|season\s?)(\d{1,2})\s+-\s+(\d{1,4})(?![0-9p]|\s*[-~]\s*\d)/i);
  if (m && type !== "movie") return { season: num(m[1]), episode: num(m[2]), range: false };
  // Season only: S01, S01-S09, Season 3, Temporada 1, S1+S2, Saison 1.
  m = text.match(
    /(?:^|[^a-z0-9])(?:s|season[ ._]?|saison[ ._]?|temporada[ ._]?|stagione[ ._]?)(\d{1,2})(?![0-9])(?:\s*(?:-|\+|to)\s*s?(\d{1,2}))?/i,
  );
  if (m && type !== "movie") return { season: num(m[1]), episode: null, range: true };
  if (type !== "series") return null;
  // Absolute numbering, as anime count: "Show - 01 [..]", "Show 1100 (WEB
  // 1080p)", "Show   22 (720p)", "01.mkv", "Show_-_01_[720p]".
  const base = text.replace(anyExt, "").replace(/_/g, " ");
  m = base.match(/(?:^|\s-\s|\s{2,}|\s)(\d{1,4}(?:\.5)?)(?:v\d)?\s*(?=[[(]|$|\s-\s|\s+\[)/);
  if (m && !/^(19|20)\d\d$/.test(m[1]!)) return { season: null, episode: num(m[1]), range: false };
  m = base.match(/(?:^|\s)(\d{1,4})\s*[-~]\s*(\d{1,4})(?=\s*[[(]|$)/);
  if (m) return { season: null, episode: null, range: true };
  return null;
}

// --- Size, seeders, cache -----------------------------------------------------

const units: Record<string, number> = { KB: 2 ** 10, MB: 2 ** 20, GB: 2 ** 30, TB: 2 ** 40 };

function readSize(s: Stream, p: Pieces): number | null {
  const hinted = s.behaviorHints?.videoSize;
  if (typeof hinted === "number" && hinted > 0) return hinted;
  // Peerflix sends it as a top-level field.
  const peerflix = s["sizebytes"];
  if (typeof peerflix === "number" && peerflix > 0) return peerflix;
  const m = p.meta.match(/💾\s*([\d.,]+)\s*(KB|MB|GB|TB)/iu);
  if (m) return Math.round(Number(m[1]!.replace(",", ".")) * units[m[2]!.toUpperCase()]!);
  return null;
}

// Cache markers are free text per addon: Torrentio writes "[TB+]" or "[RD
// download]", Comet "[AD⚡]" or "[PM⬇️]". Only known service codes count, so a
// "[EN]" tag isn't taken for one. The emoji may carry a variation selector.
// Meteor writes "[TB🌩️]" for cached and "[TB☁️]" for not cached.
const cacheMarker = /\[(TB|RD|AD|PM|DL|ED|OC|PP)(\+|⚡\uFE0F?|🌩\uFE0F?|☁\uFE0F?| ?download|⬇\uFE0F?|⏳)?\]/u;
const debrids: Partial<Record<string, Debrid>> = {
  TB: "TB",
  RD: "RD",
  AD: "AD",
  PM: "PM",
  DL: "DL",
  ED: "ED",
  OC: "OC",
  PP: "PP",
};

function readCache(name: string): { cached: boolean | null; debrid: Debrid | null } {
  const m = name.match(cacheMarker);
  const debrid = debrids[m?.[1] ?? ""];
  if (!m || !debrid) return { cached: null, debrid: null };
  const marker = m[2] ?? "";
  return { cached: marker === "+" || marker.startsWith("⚡") || marker.startsWith("🌩"), debrid };
}

const hex40 = /\b([0-9a-f]{40})\b/i;

// Debrid Torrentio drops `infoHash` and keeps the hash in its resolve URL;
// Comet keeps it in `bingeGroup`.
function readHash(s: Stream): string | null {
  const hash =
    s.infoHash ??
    s.url?.match(hex40)?.[1] ??
    s.behaviorHints?.bingeGroup?.match(hex40)?.[1] ??
    null;
  return hash ? hash.toLowerCase() : null;
}

function readSeeders(s: Stream, meta: string): number | null {
  const shown = meta.match(/👤\s*(\d+)/u)?.[1];
  if (shown !== undefined) return Number(shown);
  // Peerflix sends it as a top-level field.
  const peerflix = s["seed"];
  return typeof peerflix === "number" ? peerflix : null;
}

const extrasRe =
  /(?:^|[^a-z])(sample|trailer|teaser|featurettes?|extras?|bonus|deleted[ ._]scenes|behind[ ._]the[ ._]scenes|making[ ._]of|podcasts?|minisodes?|ost|soundtrack|nc(op|ed)|tokuten|interview)(?![a-z])|特典/i;

// --- Entry point --------------------------------------------------------------

export function parseStream(s: Stream, hints: ParseHints = {}): Parsed {
  const p = pieces(s);
  // In priority order: the file, release names, Comet's tag lines, the name.
  const texts = [...p.releases, p.cometTags, p.name].filter(Boolean);
  const all = texts.join(" | ");
  const fileLevel = p.filePath ?? p.releases[0] ?? "";

  const quality = s["quality"];
  const resolution =
    first(texts, readResolution) ?? (typeof quality === "string" ? readResolution(quality) : null);
  const sdr = /(?:^|[^a-z])sdr(?![a-z])/i.test(p.releases[0] ?? "");
  const group = first(p.releases, readGroup);
  let se = first([fileLevel, ...p.releases], (text) => readSeasonEpisode(text, hints.type));
  // "Dandadan - 01.mkv" inside "Dandadan (Season 01)": the season comes from
  // the pack's name.
  if (se && se.episode !== null && se.season === null) {
    const outer = first(p.releases.slice(1), (text) => readSeasonEpisode(text, hints.type));
    if (outer?.season != null && outer.episode === null) se = { ...se, season: outer.season };
  }
  // The file may say "BD" where the torrent says "BD Remux".
  let source = first(texts, readSource);
  if (source === "bluray" && texts.some((text) => /remux/i.test(text))) source = "remux";
  const ext = p.file?.match(anyExt)?.[1]?.toLowerCase() ?? null;
  const { cached, debrid } = readCache(p.name);
  const year = (p.file ?? p.releases[0] ?? "").match(
    /(?:^|[^0-9a-z])(19[2-9]\d|20[0-4]\d)(?![0-9]|p|x)/i,
  )?.[1];

  return {
    resolution,
    hdr: sdr ? [] : readHdr(all),
    videoCodec: first(texts, readVideoCodec),
    audioCodec: readAudio(all),
    channels: first(texts, readChannels),
    atmos: /atmos|ddpa/i.test(all),
    sizeBytes: readSize(s, p),
    source,
    group,
    languages: readLanguages(p, group, s["language"], !!hints.anime),
    season: se?.season ?? null,
    episode: se?.episode ?? null,
    // No single episode, but a range or a season.
    pack: se ? se.episode === null && (se.range || se.season !== null) : false,
    year: year ? Number(year) : null,
    cached,
    debrid,
    infoHash: readHash(s),
    fileIdx: typeof s.fileIdx === "number" ? s.fileIdx : null,
    fileName: p.file,
    releaseNames: p.releases,
    extension: ext && (videoExt.test(ext) || otherExt.test(ext)) ? ext : null,
    seeders: readSeeders(s, p.meta),
    extras: extrasRe.test(fileLevel),
  };
}
