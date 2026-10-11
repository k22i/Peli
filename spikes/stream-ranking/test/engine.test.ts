import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadFixtures, loadTitles } from '../src/corpus.ts';
import { StreamEngine } from '../src/engine.ts';
import { judge } from '../src/fakes.ts';
import { parseStream } from '../src/parse.ts';
import { defaultPrefs } from '../src/rank.ts';
import { assertClean, redactUrl } from '../src/redact.ts';
import type { Stream, TitleContext } from '../src/types.ts';

const hash = 'c3da9a3dc2ce14d0d4fc0e87d1b2023502f8dcd6';
const movie: TitleContext = { slug: 'm', kind: 'movie', type: 'movie', id: 'tt1', name: 'Some Film', year: 2024, runtimeMin: 120 };
const episode: TitleContext = { slug: 'e', kind: 'anime', type: 'series', id: 'kitsu:1:1', name: 'Some Show', year: 2023, runtimeMin: 24, episode: 1 };

const p2p = (file: string, size = '4.2 GB', seeds = 50): Stream => ({
  name: 'Torrentio\n1080p',
  title: `${file}\n👤 ${seeds} 💾 ${size} ⚙️ Tracker`,
  infoHash: hash,
  fileIdx: 0,
  behaviorHints: { filename: file },
});
const cached = (file: string, size = 4.2 * 2 ** 30): Stream => ({
  name: '[TB⚡] Comet 1080p',
  description: `📄 ${file}\n💾 ${(size / 2 ** 30).toFixed(1)} GB`,
  url: 'https://comet.example/playback/<opaque>',
  behaviorHints: { bingeGroup: `comet|torbox|${hash}`, filename: file, videoSize: size },
});

test('parses a typical scene name', () => {
  const p = parseStream(p2p('Some.Film.2024.2160p.UHD.BluRay.REMUX.DV.HDR10.HEVC.TrueHD.7.1.Atmos-GRP.mkv'), { type: 'movie' });
  assert.equal(p.resolution, '2160p');
  assert.deepEqual(p.hdr.sort(), ['DV', 'HDR10']);
  assert.equal(p.source, 'remux');
  assert.equal(p.audioCodec, 'truehd');
  assert.equal(p.channels, '7.1');
  assert.equal(p.atmos, true);
  assert.equal(p.group, 'GRP');
  assert.equal(p.year, 2024);
  assert.equal(p.cached, null);
});

test('reads Spanish episode tags and cache markers', () => {
  assert.deepEqual(
    [parseStream({ name: 'Peerflix', description: 'Separacion [HDTV 1080p][Cap.201]' }, { type: 'series' })].map((p) => [p.season, p.episode]),
    [[2, 1]],
  );
  assert.equal(parseStream({ name: '[TB download] Torrentio\n720p', title: 'x' }).cached, false);
  assert.equal(parseStream({ name: '[TB+] Torrentio\n720p', title: 'x' }).cached, true);
  assert.equal(parseStream({ name: '[TB⬇️] Comet 720p', description: 'x' }).cached, false);
});

test('hides another season, extras and executables; flags CAM separately', () => {
  const v = (file: string, ctx: TitleContext) => judge(parseStream(p2p(file), { type: ctx.type, anime: ctx.kind === 'anime' }), ctx);
  assert.equal(v('Some.Show.S02E01.1080p.WEB-DL-GRP.mkv', episode).bucket, 'hidden');
  assert.equal(v('Some Film 2024 Trailer 2 [4K].mp4', movie).bucket, 'hidden');
  assert.equal(v('Some Film 2024 1080p WEB H264-GRP.exe', movie).bucket, 'hidden');
  assert.equal(v('Some.Film.2024.1080p.CAM.H264-GRP.mkv', movie).bucket, 'low quality');
  assert.equal(v('Some.Film.2024.1080p.WEB-DL.H264-GRP.mkv', movie).bucket, 'ok');
});

test('de-duplicates the same file across addons and keeps the cached copy', () => {
  const e = new StreamEngine(movie, { ...defaultPrefs, debrid: true });
  const file = 'Some.Film.2024.1080p.WEB-DL.H264-GRP.mkv';
  e.add('torrentio', [p2p(file)]);
  e.add('comet-tb', [cached(file)]);
  const v = e.view();
  assert.equal(v.total, 1);
  assert.equal(v.top?.addon, 'comet-tb');
  assert.equal(v.top?.alternates.length, 1);
});

test('the pinned top pick stays put when a better stream arrives', () => {
  const e = new StreamEngine(movie, { ...defaultPrefs, debrid: true });
  e.add('torrentio', [p2p('Some.Film.2024.720p.WEB-DL.H264-GRP.mkv', '2 GB')]);
  const first = e.view().top;
  e.pinTop();
  e.add('comet-tb', [{ ...cached('Some.Film.2024.2160p.WEB-DL.DV.HDR.H265-GRP.mkv', 20 * 2 ** 30), behaviorHints: { filename: 'Some.Film.2024.2160p.WEB-DL.DV.HDR.H265-GRP.mkv', videoSize: 20 * 2 ** 30, bingeGroup: 'comet|torbox|' + 'a'.repeat(40) } }]);
  assert.equal(e.view().top, first);
  assert.equal(e.view().groups[0].items[0].addon, 'comet-tb');
});

test('incremental ranking matches a full rebuild on the corpus', () => {
  const titles = loadTitles();
  const fixtures = loadFixtures();
  for (const slug of ['dune-part-two', 'frieren-e01', 'lanterns-s01e08']) {
    const fs = fixtures.filter((f) => f.title === slug).sort((a, b) => a.ms - b.ms);
    const inc = new StreamEngine(titles.get(slug)!);
    for (const f of fs) inc.add(f.addon, f.streams);
    const once = new StreamEngine(titles.get(slug)!);
    once.add('all', fs.flatMap((f) => f.streams));
    const ids = (e: StreamEngine) => e.view().groups.flatMap((g) => g.items.map((c) => c.key));
    assert.deepEqual(new Set(ids(inc)), new Set(ids(once)), slug);
    assert.equal(inc.view().total, once.view().total, slug);
  }
});

test('redaction removes keys and opaque tokens but keeps hashes and file names', () => {
  const key = 'ABCDEFGH-1234-5678-9012-ABCDEFGHIJKL';
  const torrentio = redactUrl(`https://torrentio.example/resolve/torbox/${key}/${hash}/null/0/Some.Film.2024.mkv`, [key]);
  assert.equal(torrentio, `https://torrentio.example/resolve/torbox/<key>/${hash}/null/0/Some.Film.2024.mkv`);
  const comet = redactUrl(`https://comet.example/playback/${'x'.repeat(64)}/${'y'.repeat(64)}/abc?token=1`, [key]);
  assert.equal(comet, 'https://comet.example/playback/<opaque>?<redacted>');
  assert.throws(() => assertClean(`{"url":"${key}"}`, [key]));
});
