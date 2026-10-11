// Where the signal lives, per addon: the share of streams carrying each field or text marker.
// Writes results/inventory.json and prints a Markdown table.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadCorpus, root, type CorpusStream } from './corpus.ts';

const hex40 = /\b[0-9a-f]{40}\b/i;

const signals: Record<string, (c: CorpusStream) => boolean> = {
  'name: resolution': ({ stream: s }) => /\b(4k|2160p|1440p|1080p|720p|576p|480p|360p)\b/i.test(s.name ?? ''),
  'name: HDR / DV': ({ stream: s }) => /\b(HDR|DV|HDR10\+?)\b/.test(s.name ?? ''),
  'name: cached marker': ({ stream: s }) => /\[(TB|RD|AD|PM)[^\]]*\]/.test(s.name ?? ''),
  'text in `title` only': ({ stream: s }) => !!s.title && !s.description,
  'text in `description`': ({ stream: s }) => !!s.description,
  'text: torrent / release name': ({ stream: s }) => ((s.description ?? s.title ?? '').split('\n')[0] ?? '').length > 0,
  'text: size (💾)': ({ stream: s }) => /💾/.test(s.description ?? s.title ?? ''),
  'text: seeders (👤)': ({ stream: s }) => /👤/.test(s.description ?? s.title ?? ''),
  'text: tracker (⚙️ / 🔎 / 🌐)': ({ stream: s }) => /⚙️|🔎|🌐/.test(s.description ?? s.title ?? ''),
  'text: languages (flags / words)': ({ stream: s }) =>
    /[\u{1F1E6}-\u{1F1FF}]{2}|🌎|Multi Audio|Dual Audio|Dubbed/u.test(s.description ?? s.title ?? ''),
  'text: parsed tags (📹 / 🔊 / ⭐)': ({ stream: s }) => /📹|🔊|⭐/.test(s.description ?? ''),
  'behaviorHints.filename': ({ stream: s }) => !!s.behaviorHints?.filename,
  'filename has a video extension': ({ stream: s }) => /\.(mkv|mp4|avi|m4v|ts|webm|mov|wmv)$/i.test(s.behaviorHints?.filename ?? ''),
  'behaviorHints.videoSize': ({ stream: s }) => typeof s.behaviorHints?.videoSize === 'number',
  'behaviorHints.bingeGroup': ({ stream: s }) => !!s.behaviorHints?.bingeGroup,
  'bingeGroup carries the info hash': ({ stream: s }) => hex40.test(s.behaviorHints?.bingeGroup ?? ''),
  infoHash: ({ stream: s }) => !!s.infoHash,
  fileIdx: ({ stream: s }) => typeof s.fileIdx === 'number',
  url: ({ stream: s }) => !!s.url,
  'info hash recoverable (field, URL or bingeGroup)': ({ stream: s }) =>
    !!s.infoHash || hex40.test(s.url ?? '') || hex40.test(s.behaviorHints?.bingeGroup ?? ''),
  'non-standard top-level fields': ({ stream: s }) =>
    Object.keys(s).some(
      (k) => !['name', 'title', 'description', 'url', 'ytId', 'infoHash', 'fileIdx', 'externalUrl', 'sources', 'behaviorHints', 'subtitles'].includes(k),
    ),
};

const corpus = loadCorpus();
const addons = [...new Set(corpus.map((c) => c.addon))];
const table: Record<string, Record<string, number>> = {};
const counts: Record<string, number> = {};
for (const addon of addons) {
  const streams = corpus.filter((c) => c.addon === addon);
  counts[addon] = streams.length;
  table[addon] = {};
  for (const [label, test] of Object.entries(signals)) {
    table[addon][label] = Math.round((100 * streams.filter(test).length) / streams.length);
  }
}

writeFileSync(join(root, 'results', 'inventory.json'), JSON.stringify({ streams: counts, percentOfStreams: table }, null, 2) + '\n');

console.log(`| Signal | ${addons.join(' | ')} |`);
console.log(`|---|${addons.map(() => '---:').join('|')}|`);
console.log(`| streams | ${addons.map((a) => counts[a]).join(' | ')} |`);
for (const label of Object.keys(signals)) console.log(`| ${label} | ${addons.map((a) => `${table[a][label]}%`).join(' | ')} |`);
