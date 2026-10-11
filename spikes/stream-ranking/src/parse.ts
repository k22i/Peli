// Stream parser: turns one addon stream into structured fields. Pure functions, no I/O.
//
// Addons put the same facts in different places (see results/inventory.json), so the parser
// first splits a stream into named pieces (file name, release names, size line, language line,
// cache marker), then reads each field from the most specific piece that has it: the file that
// plays, then the torrent / release name, then the addon's own `name`.
import type { Stream } from './types.ts';

export type Resolution = '2160p' | '1440p' | '1080p' | '720p' | '576p' | '480p' | '360p';
export type Hdr = 'DV' | 'HDR10+' | 'HDR10';
export type VideoCodec = 'hevc' | 'avc' | 'av1' | 'xvid' | 'mpeg2' | 'vc1';
export type AudioCodec = 'truehd' | 'dts-x' | 'dts-hd' | 'lpcm' | 'flac' | 'eac3' | 'dts' | 'ac3' | 'opus' | 'aac' | 'mp3';
export type Channels = '7.1' | '5.1' | '2.0' | '1.0';
export type Source = 'remux' | 'bluray' | 'web-dl' | 'webrip' | 'hdtv' | 'dvd' | 'cam' | 'ts' | 'tc' | 'scr' | 'other';

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
  languages: string[]; // ISO 639-1, plus 'multi'
  season: number | null;
  episode: number | null;
  pack: boolean; // the size covers more than the one video that plays
  year: number | null;
  cached: boolean | null; // debrid cache state; null for P2P
  debrid: string | null; // 'TB', 'RD', ...
  infoHash: string | null;
  fileIdx: number | null;
  fileName: string | null; // the file that plays, when known
  releaseNames: string[]; // most specific first
  extension: string | null;
  seeders: number | null;
  extras: boolean; // sample / featurette / soundtrack / bonus material
};

export type ParseHints = { type?: 'movie' | 'series' };

// --- Splitting the stream into pieces -----------------------------------------------------

const metaLine = /👤|💾|⚙️|🔎|🌐|📅/u;
const flagRe = /[\u{1F1E6}-\u{1F1FF}]{2}/gu;
const cometTagLine = /^(📹|🔊|⭐|🏷️)/u;
const videoExt = /\.(mkv|mp4|avi|m4v|ts|m2ts|webm|mov|wmv|mpg|mpeg|flv|vob|iso|divx|ogm|rmvb)$/i;
const anyExt = /\.([a-z0-9]{2,4})$/i;

type Pieces = {
  name: string;
  file: string | null; // basename of the playing file
  filePath: string | null; // with folders, when the text gives them
  releases: string[]; // file first, then torrent names
  meta: string;
  langLine: string;
  cometTags: string;
};

function pieces(s: Stream): Pieces {
  const name = (s.name ?? '').replace(/\s+/g, ' ').trim();
  const text = s.description ?? s.title ?? '';
  const lines = text.split('\n').map((l) => l.trim()).filter(Boolean);
  const releases: string[] = [];
  let meta = '';
  let langLine = '';
  let cometTags = '';
  for (const line of lines) {
    if (line.startsWith('📄')) releases.push(line.replace(/^📄\s*/u, ''));
    else if (cometTagLine.test(line)) cometTags += ' ' + line;
    else if (metaLine.test(line)) meta += ' ' + line;
    else if (flagRe.test(line) || /^(🌎|Multi Audio|Dual Audio|Dubbed|Multi Subs)/u.test(line)) {
      flagRe.lastIndex = 0;
      langLine += ' ' + line;
    } else releases.push(line);
    flagRe.lastIndex = 0;
  }
  const hinted = s.behaviorHints?.filename ?? null;
  // A second release line ending in an extension is the file inside a pack (Torrentio,
  // TorrentsDB, Peerflix); it may carry folders.
  let filePath: string | null = null;
  for (const r of releases.slice(1)) if (anyExt.test(r)) filePath = r;
  if (!filePath && releases.length === 1 && anyExt.test(releases[0]) && !hinted) filePath = releases[0];
  if (!filePath && hinted) filePath = hinted;
  const file = filePath ? filePath.split('/').pop()! : null;
  // Most specific first: the file, its folders, then the remaining release names (torrent
  // name last). Folders matter: "…(1080p BluRay x265 EAC3 5.1 Silence)/S03/Featurettes/…".
  const ordered: string[] = [];
  if (file) ordered.push(file);
  if (filePath && filePath !== file) ordered.push(filePath);
  if (hinted && !ordered.includes(hinted)) ordered.push(hinted);
  for (const r of [...releases].reverse()) if (!ordered.includes(r)) ordered.push(r);
  return { name, file, filePath, releases: ordered.map(unglue), meta, langLine, cometTags };
}

// Some names glue tokens together: "HDR10x265", "DoVi HDR10x265-SM737".
function unglue(t: string): string {
  return t.replace(/(hdr10\+?|hdr)(x26[45])/gi, '$1 $2');
}

// --- Field readers -----------------------------------------------------------------------

function first<T>(texts: string[], read: (t: string) => T | null): T | null {
  for (const t of texts) {
    const v = read(t);
    if (v !== null) return v;
  }
  return null;
}

export function readResolution(t: string): Resolution | null {
  // Bare numbers ("1080") only count with a p/i suffix or inside a WxH pair.
  const withSuffix = t.match(/(?:^|[^a-z0-9])(?:m|bd|micro-?)?(2160|1440|1080|720|576|480|360)[pi](?![a-z0-9])/i);
  if (withSuffix) return `${withSuffix[1]}p` as Resolution;
  const wxh = t.match(/\b\d{3,4}\s?[x×]\s?(2160|1440|1080|720|576|480|360)\b/i);
  if (wxh) return `${wxh[1]}p` as Resolution;
  if (/\b19[12]\dx10[0-9]{2}\b/.test(t)) return '1080p';
  if (/(?:^|[^a-z0-9])(4k|uhd)(?![a-z0-9])/i.test(t) && !/tone-?mapped/i.test(t)) return '2160p';
  return null;
}

function readHdr(t: string): Hdr[] {
  const out = new Set<Hdr>();
  if (/(?:^|[^a-z0-9])(dv|dovi|dolby[ ._-]?vision|dvp\d)(?![a-z0-9])/i.test(t)) out.add('DV');
  if (/hdr10(\+|plus|p\b)/i.test(t)) out.add('HDR10+');
  const generic = /(?:^|[^a-z0-9])(hdr|hdr10|hlg)(?![a-z0-9+]|plus)/i.test(t) && !/hdr[ ._-]?tone-?mapped/i.test(t);
  if (generic && !out.has('HDR10+')) out.add('HDR10');
  return [...out];
}

function readVideoCodec(t: string): VideoCodec | null {
  const tests: [VideoCodec, RegExp][] = [
    ['hevc', /(?:^|[^a-z0-9])(x\.?265|h[ .]?265|hevc)(?![a-z0-9])/i],
    ['avc', /(?:^|[^a-z0-9])(x\.?264|h[ .]?264|avc)(?![a-z0-9])/i],
    ['av1', /(?:^|[^a-z0-9])av1(?![a-z0-9])/i],
    ['xvid', /(?:^|[^a-z0-9])(xvid|divx)(?![a-z0-9])/i],
    ['mpeg2', /(?:^|[^a-z0-9])mpeg-?2?(?![a-z0-9])/i],
    ['vc1', /(?:^|[^a-z0-9])vc-?1(?![a-z0-9])/i],
  ];
  // The first codec mentioned wins: "AVC REMUX ... (x265 encode)" is rare, and the
  // earliest token is usually the video track.
  let best: { codec: VideoCodec; at: number } | null = null;
  for (const [codec, re] of tests) {
    const m = re.exec(t);
    if (m && (!best || m.index < best.at)) best = { codec, at: m.index };
  }
  return best?.codec ?? null;
}

const audioRank: AudioCodec[] = ['truehd', 'dts-x', 'dts-hd', 'lpcm', 'flac', 'eac3', 'dts', 'ac3', 'opus', 'aac', 'mp3'];
const audioTests: [AudioCodec, RegExp][] = [
  ['truehd', /true[ ._-]?hd/i],
  ['dts-x', /(?:^|[^a-z0-9])dts[ ._:-]?x(?![a-z0-9])/i],
  ['dts-hd', /dts[ ._-]?hd|(?:^|[^a-z0-9])dts[ ._-]?ma(?![a-z0-9])|dts lossless/i],
  ['lpcm', /(?:^|[^a-z0-9])l?pcm(?![a-z0-9])/i],
  ['flac', /(?:^|[^a-z0-9])flac(?![a-z])/i],
  ['eac3', /(?:^|[^a-z0-9])(e-?ac-?3|ddpa?|dd\+|dolby digital plus)(?![a-z])/i],
  ['dts', /(?:^|[^a-z0-9])dts(?![a-z])/i],
  ['ac3', /(?:^|[^a-z0-9])(ac-?3|dd|dolbyd)(?![a-z+])|dolby digital(?! plus)/i],
  ['opus', /(?:^|[^a-z0-9])opus(?![a-z])/i],
  ['aac', /(?:^|[^a-z0-9])aac(?![a-z])/i],
  ['mp3', /(?:^|[^a-z0-9])mp3(?![a-z])/i],
];

function readAudio(t: string): AudioCodec | null {
  const found = audioTests.filter(([, re]) => re.test(t)).map(([c]) => c);
  if (!found.length) return null;
  return found.sort((a, b) => audioRank.indexOf(a) - audioRank.indexOf(b))[0];
}

function readChannels(t: string): Channels | null {
  const m = t.match(/(?<!\d)(7[ .]1|5[ .]1|2[ .]0|1[ .]0)(?!\d)/);
  if (m) return m[1].replace(' ', '.') as Channels;
  const ch = t.match(/(?:^|[^a-z0-9])([1268])\s?ch(?![a-z])/i);
  if (ch) return ({ '1': '1.0', '2': '2.0', '6': '5.1', '8': '7.1' } as const)[ch[1] as '1' | '2' | '6' | '8'];
  return null;
}

// Most severe low-quality markers first: one CAM tag outweighs a "1080p WEB" claim.
const sourceTests: [Source, RegExp][] = [
  ['cam', /(?:^|[^a-z0-9])(hd-?)?cam(-?rip)?(?![a-z0-9])/i],
  ['ts', /(?:^|[^a-z0-9])(hd-?ts|tele-?sync|ts-?rip|pdvd)(?![a-z0-9])|\[ts\]/i],
  ['tc', /(?:^|[^a-z0-9])(hd-?tc|tele-?cine)(?![a-z0-9])/i],
  ['scr', /(?:^|[^a-z0-9])(screener|dvd-?scr|bd-?scr|web-?scr|scr)(?![a-z0-9])/i],
  ['remux', /remux/i],
  ['webrip', /(?:^|[^a-z0-9])(web-?(dl)?-?rip|netflix-?rip|amazon-?rip)(?![a-z0-9])/i],
  ['web-dl', /(?:^|[^a-z0-9])(web-?dl|web)(?![a-z0-9])/i],
  ['bluray', /(?:^|[^a-z0-9])(blu-?ray|bd-?rip|br-?rip|bdmux|bd(?=[0-9 \]])|bd)(?![a-z0-9])|bluray rip/i],
  ['hdtv', /(?:^|[^a-z0-9])hdtv(-?rip)?(?![a-z0-9])/i],
  ['dvd', /(?:^|[^a-z0-9])dvd(-?rip|r|5|9)?(?![a-z0-9])/i],
  ['other', /(?:^|[^a-z0-9])(dcp(-?rip)?|hd-?rip|vhs-?rip|tv-?rip|sat-?rip)(?![a-z0-9])/i],
];

function readSource(t: string): Source | null {
  for (const [source, re] of sourceTests) if (re.test(t)) return source;
  return null;
}

// --- Release group ------------------------------------------------------------------------

const notGroup = new Set(
  [
    'x264', 'x265', 'h264', 'h265', 'hevc', 'avc', 'av1', 'aac', 'ac3', 'eac3', 'dts', 'ddp', 'dd', 'flac', 'opus', 'mp3',
    'web', 'webdl', 'webrip', 'bluray', 'bdrip', 'brrip', 'hdtv', 'dl', 'rip', 'remux', 'hdr', 'sdr', 'dv',
    'dual', 'multi', 'lat', 'latino', 'eng', 'ita', 'spa', 'esp', 'fre', 'ger', 'jap', 'kor', 'rus', 'hin',
    '1080p', '720p', '2160p', '480p', '4k', 'uhd', 'mkv', 'mp4', 'avi', 'sub', 'subs', 'esub', 'msubs',
    'repack', 'proper', 'internal', 'final', 'complete', 'batch', 'raw', 'raws',
  ].map((s) => s.toLowerCase()),
);
const siteLike = /(www\.|\.(com|org|net|io|to|tv|cc|pm|in|me|tax|ws|mx|lt|am|ag|se)\b|eztv|tgx|rartv)/i;
// Tokens that describe the encode. A release group follows them; title words don't.
const techToken =
  /^(x26[45]|h\.?26[45]|hevc|avc|av1|xvid|divx|aac\d?|e?ac3|ddp?a?\d?|dts(-?hd)?|truehd|atmos|flac|opus|\d{3,4}[pi]|4k|uhd|hdr(10)?(\+|plus)?|sdr|dv|10-?bits?|blu-?ray|bdrip|brrip|bd|web(-?dl|rip)?|webdl|dlrip|hdtv|remux|hdrip|dcp(rip)?|\d\.\d|\dch|mkv|mp4)$/i;
const langOrSub = /^(cz|czsub|sub|subs|esub|msubs|eng|ita|spa|esp|lat|latino|dual|multi|es|en|fr|ru|pl|vostfr|castellano|es-en)$/i;
const hasTech = (s: string) => s.split(/[\s._\-[\]()]+/).some((p) => techToken.test(p));

function validGroup(g: string | undefined): string | null {
  if (!g) return null;
  const v = g.trim().replace(/^[\[(]|[\])]$/g, '').trim();
  if (!v || v.length > 32) return null;
  if (notGroup.has(v.toLowerCase()) || langOrSub.test(v) || techToken.test(v)) return null;
  if (/^\d+$/.test(v) || /^[0-9a-f]{8}$/i.test(v)) return null;
  if (/^(s\d|e\d|\d{3,4}p|cap\.?\s?\d|temporada|season)/i.test(v)) return null;
  return v;
}

// One hyphen segment as a group: "MeGusta", "YTS.MX", "MeM.GP", "BYNDR.CZsub" → "BYNDR",
// "Pahe.in" → "Pahe". Segments with spaces or encode tokens are title or tech, not a group.
function groupFromSegment(seg: string): string | null {
  let v = seg.trim().replace(/^\[|\]$/g, '').trim();
  if (!v || /\s/.test(v) || hasTech(v)) return null;
  if (/^YTS\.[A-Z]{2}$/i.test(v)) return v;
  const parts = v.split('.');
  while (parts.length > 1 && langOrSub.test(parts[parts.length - 1])) parts.pop();
  v = parts.join('.');
  if (/^www\./i.test(v)) return null;
  if (siteLike.test(v)) v = v.replace(/\.[a-z]{2,3}$/i, '');
  return validGroup(v);
}

function readGroup(t: string): string | null {
  const base = t.replace(anyExt, '').trim();
  const raws = base.match(/(?:^|[\s[(-])([A-Za-z0-9]+-Raws)(?![A-Za-z])/i);
  if (raws) return raws[1];
  // [Group] at the start, as anime fansubs do. Skip site tags and CJK tags.
  const lead = base.match(/^\[([^\]]+)\]/);
  if (lead && !siteLike.test(lead[1]) && !/[　-鿿]/.test(lead[1])) {
    const g = validGroup(lead[1]);
    if (g) return g;
  }
  // -GROUP at the end (after trailing [site] / (hash) tags are removed), but only when an
  // encode token comes before it: "The Amazing Spider-Man" has no group.
  const stripped = base.replace(/(\s*[\[(][^\])]*[\])])+\s*$/g, '');
  const segs = stripped.split('-');
  for (let i = segs.length - 1; i >= Math.max(1, segs.length - 2); i--) {
    const seg = segs[i].trim();
    if (langOrSub.test(seg)) continue; // "-HEVC-PSA-CZ", "1080P-Dual-Lat"
    const g = groupFromSegment(seg);
    if (g && hasTech(segs.slice(0, i).join('-'))) return g;
    break;
  }
  // "… x264.seleZen", "… ac3 mHDgz", "… HDR.NEWCOMERS": a last word right after an encode token.
  const words = stripped.split(/[\s.]+/).filter(Boolean);
  const last = words[words.length - 1];
  if (words.length > 2 && techToken.test(words[words.length - 2]) && /^[A-Za-z][A-Za-z0-9_]{2,}$/.test(last)) {
    const g = validGroup(last);
    if (g) return g;
  }
  // "(1080p BluRay x265 HEVC 10bit AAC 5.1 Joy)": QxR-style encoder tag at the end of a tech group.
  const qxr = base.match(/\(([^()]*)\s([A-Za-z][A-Za-z0-9]{1,15})\)/);
  if (qxr && hasTech(qxr[1])) {
    const g = validGroup(qxr[2]);
    if (g) return g;
  }
  // "by Me7alh", "by.AKTEP", "от Kerob"
  const by = base.match(/(?:^|[\s.])(?:by[\s.]?|от\s)([A-Za-z][A-Za-z0-9_]{2,})(?:\s|\.|$)/);
  if (by) return validGroup(by[1]);
  // A trailing [Group] as in "[Prof]", "[QxR]".
  const trailing = base.match(/\[([A-Za-z][A-Za-z0-9]{1,15})\]\s*$/);
  if (trailing && !siteLike.test(trailing[1])) return validGroup(trailing[1]);
  return null;
}

// --- Languages ----------------------------------------------------------------------------

const flagToLang: Record<string, string> = {
  GB: 'en', US: 'en', JP: 'ja', IT: 'it', PT: 'pt', BR: 'pt', ES: 'es', MX: 'es', FR: 'fr', DE: 'de', NL: 'nl',
  PL: 'pl', CZ: 'cs', HU: 'hu', BG: 'bg', RS: 'sr', HR: 'hr', DK: 'da', SE: 'sv', NO: 'no', TR: 'tr', IL: 'he',
  VN: 'vi', ID: 'id', MY: 'ms', TH: 'th', KR: 'ko', CN: 'zh', TW: 'zh', HK: 'zh', IN: 'hi', SA: 'ar', RU: 'ru',
  UA: 'uk', LT: 'lt', LV: 'lv', EE: 'et', GR: 'el', RO: 'ro', FI: 'fi', SK: 'sk', SI: 'sl', IR: 'fa', AZ: 'az',
};

const langWords: [string, RegExp][] = [
  ['en', /(?:^|[^a-z])(eng|english|inglés|ingles)(?![a-z])|(?:^|[^A-Za-z])EN(?![A-Za-z])/i],
  ['it', /(?:^|[^a-z])(ita|italian)(?![a-z])/i],
  ['es', /(?:^|[^a-z])(spa|esp|spanish|castellano|latino|lat|español)(?![a-z])|(?:^|[^A-Za-z])ES(?![A-Za-z])/i],
  ['fr', /(?:^|[^a-z])(french|truefrench|vff|vfq|vf2|vfi)(?![a-z])|(?:^|[^A-Za-z])FR(?![A-Za-z])/i],
  ['de', /(?:^|[^a-z])(german|deutsch|ger)(?![a-z])/i],
  ['ja', /(?:^|[^a-z])(jap|jpn|japanese)(?![a-z])/i],
  ['ko', /(?:^|[^a-z])(kor|korean|coreano)(?![a-z])/i],
  ['ru', /(?:^|[^a-z])(rus|russian)(?![a-z])/i],
  ['hi', /(?:^|[^a-z])(hin|hindi)(?![a-z])/i],
  ['ta', /(?:^|[^a-z])(tam|tamil)(?![a-z])/i],
  ['te', /(?:^|[^a-z])(tel|telugu|telegu)(?![a-z])/i],
  ['kn', /(?:^|[^a-z])(kan|kannada)(?![a-z])/i],
  ['pt', /(?:^|[^a-z])(pt-?br|ptbr|dublado|portuguese)(?![a-z])/i],
  ['pl', /(?:^|[^A-Za-z])PL(?![A-Za-z])|(?:^|[^a-z])(polish|lektor)(?![a-z])/i],
  ['cs', /(?:^|[^A-Za-z])CZ(?![A-Za-z])|(?:^|[^a-z])czech(?![a-z])/i],
  ['hu', /(?:^|[^a-z])(hun|hungarian)(?![a-z])/i],
  ['lt', /(?:^|[^A-Za-z.])LT(?![A-Za-z])/],
  ['uk', /(?:^|[^a-z])(ukr|ukrainian)(?![a-z])/i],
  ['az', /(?:^|[^a-z])azerbaijan/i],
  ['zh', /mandarin|cantonese|国语|國語|粤语|粵語/i],
];

// "Multi Subs" means every flag is a subtitle language. These name one subtitle language.
const allFlagsAreSubs = /multi[ -]?subs?|multiple subtitle/i;
const subtitleLanguage: [RegExp, string][] = [
  [/legendado/i, 'pt'],
  [/subtitulado|vose/i, 'es'],
  [/vostfr/i, 'fr'],
  [/subs?[ ._-]?pt-?br/i, 'pt'],
];

function readLanguages(p: Pieces, group: string | null, extraLang: unknown, anime: boolean): string[] {
  const out = new Set<string>();
  const names = p.releases.join(' | ');
  const text = group ? names.split(group).join(' ') : names;
  // Words in release names. "sub ita.eng", "ESub", "Eng Sub" are subtitles; "DOBLADA EN
  // CASTELLANO" is Spanish, not English.
  const cleaned = text
    .replace(/multi[ -]?subs?|(eng|ita|spa)[ ._-]+subs?/gi, ' ')
    .replace(/(e?subs?|subtitles?)[ ._-]*(ita|eng|spa|rus|ukr|fr|cz|pt-?br)?([ ._-]*(ita|eng|spa|rus|ukr))*/gi, ' ')
    .replace(/(?:^|[^a-z])en[ ._](castellano|español|espanol)/gi, ' $1');
  for (const [code, re] of langWords) if (re.test(cleaned)) out.add(code);
  const multi =
    /(?:^|[^a-z])(multi|dual|daul)(?![a-z])(?![ -]?subs?)|multi[ -]?audio|dual[ -]?audio|multi\d/i.test(cleaned) ||
    /multi audio|dual audio/i.test(p.langLine);
  if (multi) out.add('multi');
  if (multi && anime && /dual[ -]?audio/i.test(names + p.langLine)) {
    out.add('ja');
    out.add('en');
  }
  // German.DL ("Deutsch + original"): German plus the original language.
  if (/german[ ._-]+(dubbed[ ._-]+)?dl(?![a-z])/i.test(cleaned)) {
    out.add('de');
    out.add(anime ? 'ja' : 'en');
  }
  if (!allFlagsAreSubs.test(p.langLine + ' ' + names)) {
    for (const f of p.langLine.match(flagRe) ?? []) {
      const cc = [...f].map((c) => String.fromCharCode(c.codePointAt(0)! - 0x1f1e6 + 65)).join('');
      const code = flagToLang[cc];
      if (code) out.add(code);
    }
  }
  // Peerflix sends the release language as a top-level field.
  if (typeof extraLang === 'string' && /^[a-z]{2}$/.test(extraLang)) out.add(extraLang);
  for (const [re, code] of subtitleLanguage) if (re.test(names)) out.delete(code);
  return [...out];
}

// --- Season / episode ---------------------------------------------------------------------

type SE = { season: number | null; episode: number | null; range: boolean };

function readSeasonEpisode(t: string, type: ParseHints['type']): SE | null {
  let m = t.match(/(?:^|[^a-z0-9])s(\d{1,2})\s*[-._ ]?\s*e(\d{1,4}(?:\.5)?)(?:\s*-\s*e?(\d{1,4}))?/i);
  if (m) return { season: Number(m[1]), episode: m[3] ? null : Number(m[2]), range: !!m[3] };
  m = t.match(/(?:^|[^a-z0-9])(\d{1,2})x(\d{1,3})(?:\s*-\s*(\d{1,3}))?(?![0-9])/i);
  if (m && Number(m[1]) < 40) return { season: Number(m[1]), episode: m[3] ? null : Number(m[2]), range: !!m[3] };
  m = t.match(/cap\.?\s?(\d{1,2})(\d{2})(?:[_-](\d{1,2})(\d{2}))?(?![0-9])/i);
  if (m) return { season: Number(m[1]), episode: m[3] ? null : Number(m[2]), range: !!m[3] };
  m = t.match(/(?:^|[^a-z0-9])e(\d{2,4})\s*-\s*e?(\d{2,4})(?![0-9])/i);
  if (m) return { season: null, episode: null, range: true };
  // Season-only: S01, S01-S09, Season 3, Temporada 1, S1+S2, Saison 1
  m = t.match(/(?:^|[^a-z0-9])(?:s|season[ ._]?|saison[ ._]?|temporada[ ._]?|stagione[ ._]?)(\d{1,2})(?![0-9])(?:\s*(?:-|\+|to)\s*s?(\d{1,2}))?/i);
  if (m && type !== 'movie') return { season: Number(m[1]), episode: null, range: true };
  if (type !== 'series') return null;
  // Anime absolute numbering: "Show - 01 [..]", "Show 1100 (WEB 1080p)", "Show   22 (720p)", "01.mkv"
  const base = t.replace(anyExt, '');
  m = base.match(/(?:^|\s-\s|\s{2,}|\s)(\d{1,4}(?:\.5)?)(?:v\d)?\s*(?=[\[(]|$|\s-\s)/);
  if (m && !/^(19|20)\d\d$/.test(m[1])) return { season: null, episode: Number(m[1]), range: false };
  m = base.match(/(?:^|\s)(\d{1,4})\s*[-~]\s*(\d{1,4})(?=\s*[\[(]|$)/);
  if (m) return { season: null, episode: null, range: true };
  return null;
}

// --- Size, seeders, cache -----------------------------------------------------------------

const unit: Record<string, number> = { KB: 2 ** 10, MB: 2 ** 20, GB: 2 ** 30, TB: 2 ** 40 };

function readSize(s: Stream, p: Pieces): number | null {
  const vs = s.behaviorHints?.videoSize;
  if (typeof vs === 'number' && vs > 0) return vs;
  if (typeof s.sizebytes === 'number' && s.sizebytes > 0) return s.sizebytes;
  const m = p.meta.match(/💾\s*([\d.,]+)\s*(KB|MB|GB|TB)/i);
  if (m) return Math.round(Number(m[1].replace(',', '.')) * unit[m[2].toUpperCase()]);
  return null;
}

function readCache(name: string): { cached: boolean | null; debrid: string | null } {
  const m = name.match(/\[([A-Z]{2})(\+|⚡| ?download|⬇️|⏳)?\]/u);
  if (!m) return { cached: null, debrid: null };
  const marker = m[2] ?? '';
  return { cached: marker === '+' || marker === '⚡', debrid: m[1] };
}

const hex40 = /\b([0-9a-f]{40})\b/i;

function readHash(s: Stream): string | null {
  const h = s.infoHash ?? s.url?.match(hex40)?.[1] ?? s.behaviorHints?.bingeGroup?.match(hex40)?.[1] ?? null;
  return h ? h.toLowerCase() : null;
}

const extrasRe =
  /(?:^|[^a-z])(sample|trailer|teaser|featurettes?|extras?|bonus|deleted[ ._]scenes|behind[ ._]the[ ._]scenes|making[ ._]of|podcasts?|minisodes?|ost|soundtrack|nc(op|ed)|tokuten|interview)(?![a-z])|特典/i;

// --- Entry point --------------------------------------------------------------------------

export function parseStream(s: Stream, hints: ParseHints & { anime?: boolean } = {}): Parsed {
  const p = pieces(s);
  // Texts in priority order: file, release names, Comet's tag lines, the addon's name.
  const texts = [...p.releases, p.cometTags, p.name].filter(Boolean);
  const all = texts.join(' | ');
  const fileLevel = p.filePath ?? p.releases[0] ?? '';

  const resolution = first(texts, readResolution) ?? (typeof s.quality === 'string' ? readResolution(s.quality) : null);
  const hdrTexts = /(?:^|[^a-z])sdr(?![a-z])/i.test(p.releases[0] ?? '') ? [] : readHdr(all);
  const group = first(p.releases, readGroup);
  let se = first([fileLevel, ...p.releases], (t) => readSeasonEpisode(t, hints.type));
  // "Dandadan - 01.mkv" inside "Dandadan (Season 01)": the season comes from the pack name.
  if (se && se.episode !== null && se.season === null) {
    const outer = first(p.releases.slice(1), (t) => readSeasonEpisode(t, hints.type));
    if (outer?.season != null && outer.episode === null) se = { ...se, season: outer.season };
  }
  // The file may say "BD" where the torrent says "BD Remux".
  let source = first(texts, readSource);
  if (source === 'bluray' && texts.some((t) => /remux/i.test(t))) source = 'remux';
  const ext = p.file?.match(anyExt)?.[1]?.toLowerCase() ?? null;
  const size = readSize(s, p);
  const { cached, debrid } = readCache(p.name);

  // Pack: the stream's shown size covers several videos. True when no single episode is
  // identified but a range / season is, or when the addon shows a torrent name without a file.
  const pack = se ? se.episode === null && (se.range || se.season !== null) : false;

  const yearM = (p.file ?? p.releases[0] ?? '').match(/(?:^|[^0-9a-z])(19[2-9]\d|20[0-4]\d)(?![0-9]|p|x)/i);

  return {
    resolution,
    hdr: hdrTexts,
    videoCodec: first(texts, readVideoCodec),
    audioCodec: first([all], readAudio),
    channels: first(texts, readChannels),
    atmos: /atmos|ddpa/i.test(all),
    sizeBytes: size,
    source,
    group,
    languages: readLanguages(p, group, s.language, !!hints.anime),
    season: se?.season ?? null,
    episode: se?.episode ?? null,
    pack,
    year: yearM ? Number(yearM[1]) : null,
    cached,
    debrid,
    infoHash: readHash(s),
    fileIdx: typeof s.fileIdx === 'number' ? s.fileIdx : null,
    fileName: p.file,
    releaseNames: p.releases,
    extension: ext && videoExt.test('.' + ext) ? ext : ext && /^(zip|rar|7z|exe|iso|txt|nfo|srt|ass|mp3|flac|m4a|pdf|jpg|png|lnk|scr|bat)$/.test(ext) ? ext : null,
    seeders: Number(p.meta.match(/👤\s*(\d+)/u)?.[1] ?? (typeof s.seed === 'number' ? s.seed : NaN)) || (/👤\s*0/u.test(p.meta) ? 0 : null),
    extras: extrasRe.test(fileLevel),
  };
}
