// Records the fixture corpus: /stream responses from public addons for the titles in titles.ts,
// with and without a TorBox config. Run sparingly; it is polite (sequential, delayed, honest UA).
//
//   node src/record.ts            # everything
//   node src/record.ts torrentio  # one addon
//   node src/record.ts titles     # only refresh fixtures/titles.json
//   node src/record.ts matching [slug,slug]  # #99: the title-matching set (titles-matching.ts), Torrentio only,
//                                 # into fixtures/torrentio and fixtures/titles-matching.json; the
//                                 # other fixtures and titles.json are left alone
//
// Debrid keys live in git-ignored .env (TORBOX_API_KEY). Before a fixture is written, the key,
// the config path segment and any opaque URL token are redacted, and the file is checked for
// leftovers.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertClean, redactStreams } from './redact.ts';
import { titles, type TitleSpec } from './titles.ts';
import { matchingTitles } from './titles-matching.ts';
import type { Fixture, TitleContext } from './types.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
try {
  process.loadEnvFile(join(root, '.env'));
} catch {
  // No .env: P2P addons only.
}

const userAgent = 'Sinag/0.0.0-spike (+https://github.com/k22i/Sinag; stream-ranking spike)';
const torbox = process.env.TORBOX_API_KEY ?? '';
const delayMs = 1500;

type Addon = {
  key: string;
  config: Fixture['config'];
  base: string;
  prefixes: string[];
  // Path segment carrying the user's config, if any. Built lazily because some need a request.
  configSegment?: () => Promise<string>;
};

const addons: Addon[] = [
  { key: 'torrentio', config: 'p2p', base: 'https://torrentio.strem.fun', prefixes: ['tt', 'kitsu'] },
  { key: 'torrentsdb', config: 'p2p', base: 'https://torrentsdb.com', prefixes: ['tt', 'kitsu'] },
  { key: 'peerflix', config: 'p2p', base: 'https://peerflix.mov', prefixes: ['tt'] },
  {
    key: 'torrentio-tb',
    config: 'torbox',
    base: 'https://torrentio.strem.fun',
    prefixes: ['tt', 'kitsu'],
    configSegment: async () => `torbox=${torbox}`,
  },
  {
    key: 'comet-tb',
    config: 'torbox',
    base: 'https://comet.elfhosted.com',
    prefixes: ['tt', 'kitsu'],
    configSegment: async () => Buffer.from(JSON.stringify({ debridService: 'torbox', debridApiKey: torbox })).toString('base64'),
  },
  // MediaFusion (ElfHosted) is left out: every title came back with 0 streams, both without a
  // config and with a TorBox config built through /encrypt-user-data
  // ({ streaming_provider: { service, token } }). Not debugged further in this spike.
];

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function getJson(url: string): Promise<{ status: number; ms: number; body: any }> {
  const started = performance.now();
  const res = await fetch(url, { headers: { 'User-Agent': userAgent }, signal: AbortSignal.timeout(60_000) });
  const text = await res.text();
  const ms = Math.round(performance.now() - started);
  let body: any = null;
  try {
    body = JSON.parse(text);
  } catch {
    body = { nonJson: text.slice(0, 200) };
  }
  return { status: res.status, ms, body };
}

// --- Title context (what /meta would give the app) ------------------------------------------

async function context(t: TitleSpec): Promise<TitleContext> {
  const [prefix, a, b, c] = t.id.split(':');
  if (prefix === 'kitsu') {
    const { body } = await getJson(`https://kitsu.io/api/edge/anime/${a}`);
    const at = body.data.attributes;
    const aliases = [...Object.values(at.titles ?? {}), ...(at.abbreviatedTitles ?? [])].filter(
      (a): a is string => typeof a === 'string' && a !== at.canonicalTitle,
    );
    const ctx: TitleContext = {
      slug: t.slug,
      kind: t.kind,
      type: t.type,
      id: t.id,
      name: at.canonicalTitle,
      aliases: [...new Set(aliases)],
      year: Number(String(at.startDate).slice(0, 4)),
      runtimeMin: at.episodeLength ?? undefined,
    };
    if (b) ctx.absoluteEpisode = ctx.episode = Number(b);
    return ctx;
  }
  const { body } = await getJson(`https://v3-cinemeta.strem.io/meta/${t.type}/${prefix}.json`);
  const m = body.meta;
  const ctx: TitleContext = {
    slug: t.slug,
    kind: t.kind,
    type: t.type,
    id: t.id,
    name: m.name,
    year: Number(String(m.releaseInfo ?? m.year).slice(0, 4)) || undefined,
    runtimeMin: Number(String(m.runtime ?? '').match(/\d+/)?.[0]) || undefined,
  };
  if (a) {
    ctx.season = Number(a);
    ctx.episode = Number(b);
    // Series runtime in Cinemeta is per episode.
  }
  void c;
  return ctx;
}

// --- Main ------------------------------------------------------------------------------------

const only = process.argv[2];
const matching = only === 'matching';
const slugs = process.argv[3]?.split(',');
const set: TitleSpec[] = matching
  ? matchingTitles.filter((t) => !slugs || slugs.includes(t.slug))
  : titles;
const selected = addons
  .filter((a) => (matching ? a.key === 'torrentio' : only ? a.key === only : true))
  .filter((a) => a.config === 'p2p' || torbox);
if (!torbox && !matching) console.error('TORBOX_API_KEY not set: skipping debrid configs');

mkdirSync(join(root, 'fixtures'), { recursive: true });
const contexts: TitleContext[] = [];
for (const t of set) {
  const ctx = await context(t);
  if (matching) {
    // Hand-written stand-ins for TMDB's alternative titles and translations.
    const spec = matchingTitles.find((m) => m.slug === t.slug)!;
    ctx.aliases = spec.aliases;
    ctx.aliasesSource = 'manual';
  }
  contexts.push(ctx);
  await sleep(300);
}
const titlesFile = join(root, 'fixtures', matching ? 'titles-matching.json' : 'titles.json');
if (matching && slugs) {
  // Add to the recorded set; re-recording a title would change its streams' indexes, and the labels use them.
  const old: TitleContext[] = existsSync(titlesFile) ? JSON.parse(readFileSync(titlesFile, 'utf8')) : [];
  contexts.unshift(...old.filter((o) => !contexts.some((c) => c.slug === o.slug)));
}
writeFileSync(titlesFile, JSON.stringify(contexts, null, 2) + '\n');
if (only === 'titles') process.exit(0);

for (const addon of selected) {
  const segment = addon.configSegment ? await addon.configSegment() : '';
  const secrets = [torbox, segment].filter(Boolean);
  mkdirSync(join(root, 'fixtures', addon.key), { recursive: true });
  for (const t of set) {
    const prefix = t.id.startsWith('kitsu:') ? 'kitsu' : 'tt';
    if (!addon.prefixes.includes(prefix)) continue;
    const url = `${addon.base}${segment ? `/${segment}` : ''}/stream/${t.type}/${encodeURIComponent(t.id)}.json`;
    let fixture: Fixture;
    try {
      const { status, ms, body } = await getJson(url);
      fixture = {
        addon: addon.key,
        config: addon.config,
        title: t.slug,
        request: url.split(segment || '\0').join('<config>').replace(torbox || '\0', '<key>'),
        recordedAt: new Date().toISOString(),
        status,
        ms,
        streams: redactStreams(Array.isArray(body?.streams) ? body.streams : [], secrets),
      };
    } catch (err) {
      console.error(`${addon.key} ${t.slug}: ${(err as Error).message}`);
      continue;
    }
    const json = JSON.stringify(fixture, null, 2) + '\n';
    assertClean(json, secrets);
    writeFileSync(join(root, 'fixtures', addon.key, `${t.slug}.json`), json);
    console.log(`${addon.key.padEnd(15)} ${t.slug.padEnd(26)} ${fixture.status} ${String(fixture.ms).padStart(6)}ms ${fixture.streams.length} streams`);
    await sleep(delayMs);
  }
}
