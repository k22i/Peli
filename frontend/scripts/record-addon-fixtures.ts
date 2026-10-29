// Records the typed addon client's test fixtures (#37): real answers from
// popular public addons, trimmed to a few items each so they stay small.
//
//   pnpm run record:addons
//
// Stream answers aren't fetched here: they come from the stream-ranking
// spike's corpus (spikes/stream-ranking/fixtures, debrid keys already
// redacted), trimmed the same way. Fixtures are for tests only; no content
// links go in docs.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const out = join(here, "../src/lib/addon-protocol/fixtures");
const spike = join(here, "../../spikes/stream-ranking/fixtures");
const userAgent = "Sinag/0.0.0-dev (+https://github.com/k22i/Sinag; test fixtures)";

type Json = Record<string, unknown>;

function json(value: unknown): Json {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("expected a JSON object");
  }
  return Object.fromEntries(Object.entries(value));
}

// What to keep of each list, so a fixture shows every shape without
// thousands of items.
const keep = { metas: 4, streams: 12, subtitles: 8, videos: 4 };

function trim(body: Json): Json {
  const trimmed: Json = { ...body };
  for (const key of ["metas", "streams", "subtitles"] as const) {
    const list = trimmed[key];
    if (Array.isArray(list)) trimmed[key] = list.slice(0, keep[key]);
  }
  const meta = trimmed["meta"];
  if (meta && typeof meta === "object" && "videos" in meta && Array.isArray(meta.videos)) {
    trimmed["meta"] = { ...meta, videos: meta.videos.slice(0, keep.videos) };
  }
  return trimmed;
}

function write(addon: string, name: string, body: Json) {
  mkdirSync(join(out, addon), { recursive: true });
  writeFileSync(join(out, addon, `${name}.json`), `${JSON.stringify(trim(body), null, 2)}\n`);
  console.log(`${addon}/${name}.json`);
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function record(addon: string, name: string, url: string) {
  const response = await fetch(url, {
    headers: { "User-Agent": userAgent },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`${addon}/${name}: HTTP ${response.status}`);
  write(addon, name, json(await response.json()));
  // Polite: one request at a time.
  await sleep(500);
}

const cinemeta = "https://v3-cinemeta.strem.io";
const kitsu = "https://anime-kitsu.strem.fun";
const opensubtitles = "https://opensubtitles-v3.strem.io";

const requests: [addon: string, name: string, url: string][] = [
  ["cinemeta", "manifest", `${cinemeta}/manifest.json`],
  ["cinemeta", "catalog-movie-top", `${cinemeta}/catalog/movie/top.json`],
  ["cinemeta", "catalog-movie-top-genre", `${cinemeta}/catalog/movie/top/genre=Drama.json`],
  ["cinemeta", "catalog-series-top-skip", `${cinemeta}/catalog/series/top/skip=100.json`],
  ["cinemeta", "catalog-movie-year", `${cinemeta}/catalog/movie/year/genre=2024.json`],
  ["cinemeta", "catalog-movie-search", `${cinemeta}/catalog/movie/top/search=dune.json`],
  ["cinemeta", "meta-movie", `${cinemeta}/meta/movie/tt0111161.json`],
  ["cinemeta", "meta-series", `${cinemeta}/meta/series/tt0903747.json`],
  ["kitsu", "manifest", `${kitsu}/manifest.json`],
  ["kitsu", "catalog-anime-trending", `${kitsu}/catalog/anime/kitsu-anime-trending.json`],
  ["kitsu", "meta-anime", `${kitsu}/meta/anime/kitsu:46474.json`],
  ["opensubtitles", "manifest", `${opensubtitles}/manifest.json`],
  ["opensubtitles", "subtitles-movie", `${opensubtitles}/subtitles/movie/tt0111161.json`],
  ["torrentio", "manifest", "https://torrentio.strem.fun/manifest.json"],
  ["peerflix", "manifest", "https://peerflix.mov/manifest.json"],
  ["comet", "manifest", "https://comet.elfhosted.com/manifest.json"],
  ["mediafusion", "manifest", "https://mediafusion.elfhosted.com/manifest.json"],
  // Needs configuring before it answers anything.
  ["aiostreams", "manifest", "https://aiostreams.elfhosted.com/stremio/manifest.json"],
  // A web app's manifest, not an addon's, and sent without CORS headers: a
  // wrong URL pasted into the addon manager.
  ["aiostreams", "web-app-manifest", "https://aiostreams.elfhosted.com/manifest.json"],
];

// From the spike: Torrentio and TorrentsDB send only the deprecated `title`,
// Peerflix adds non-standard top-level fields, Comet (TorBox) has
// `description` and redacted debrid links.
const streams: [addon: string, name: string, spikeFile: string][] = [
  ["torrentio", "stream-series", "torrentio/breaking-bad-s01e01.json"],
  ["torrentio", "stream-anime", "torrentio/frieren-e01.json"],
  ["torrentsdb", "stream-movie", "torrentsdb/dune-part-two.json"],
  ["peerflix", "stream-movie", "peerflix/dune-part-two.json"],
  ["comet", "stream-movie-torbox", "comet-tb/dune-part-two.json"],
];

const only = process.argv[2];
for (const [addon, name, url] of requests) {
  // oxlint-disable-next-line no-await-in-loop -- one request at a time, to be polite
  if (!only || only === addon) await record(addon, name, url);
}
for (const [addon, name, file] of streams) {
  if (only && only !== addon) continue;
  const { streams: list } = json(JSON.parse(readFileSync(join(spike, file), "utf8")));
  write(addon, name, { streams: list });
}
