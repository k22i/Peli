import { describe, expect, it } from "vite-plus/test";

import aiostreams from "./fixtures/aiostreams/manifest.json";
import webAppManifest from "./fixtures/aiostreams/web-app-manifest.json";
import cinemetaMovieTop from "./fixtures/cinemeta/catalog-movie-top.json";
import cinemeta from "./fixtures/cinemeta/manifest.json";
import cinemetaMovie from "./fixtures/cinemeta/meta-movie.json";
import cinemetaSeries from "./fixtures/cinemeta/meta-series.json";
import comet from "./fixtures/comet/manifest.json";
import cometStreams from "./fixtures/comet/stream-movie-torbox.json";
import kitsuTrending from "./fixtures/kitsu/catalog-anime-trending.json";
import kitsu from "./fixtures/kitsu/manifest.json";
import kitsuAnime from "./fixtures/kitsu/meta-anime.json";
import mediafusion from "./fixtures/mediafusion/manifest.json";
import opensubtitles from "./fixtures/opensubtitles/manifest.json";
import opensubtitlesMovie from "./fixtures/opensubtitles/subtitles-movie.json";
import peerflix from "./fixtures/peerflix/manifest.json";
import peerflixStreams from "./fixtures/peerflix/stream-movie.json";
import torrentio from "./fixtures/torrentio/manifest.json";
import torrentioStreams from "./fixtures/torrentio/stream-series.json";
import torrentsdbStreams from "./fixtures/torrentsdb/stream-movie.json";
import {
  InvalidAnswer,
  parseCatalogResponse,
  parseManifest,
  parseMetaResponse,
  parseStreamResponse,
  parseSubtitlesResponse,
} from "./parse";

describe("parseManifest", () => {
  it("reads every recorded addon's manifest", () => {
    const manifests = [aiostreams, cinemeta, comet, kitsu, mediafusion, opensubtitles, peerflix];
    for (const answer of [...manifests, torrentio]) {
      const manifest = parseManifest(answer);
      expect(manifest.id).toBe(answer.id);
      expect(manifest.version).toBe(answer.version);
    }
  });

  it("refuses what isn't an addon manifest", () => {
    // AIOStreams' root serves its web app's manifest: a wrong URL pasted in.
    expect(() => parseManifest(webAppManifest)).toThrow(InvalidAnswer);
    expect(() => parseManifest(null)).toThrow(InvalidAnswer);
    expect(() => parseManifest([])).toThrow(InvalidAnswer);
    expect(() => parseManifest({ id: "x", name: "X" })).toThrow(InvalidAnswer);
  });

  it("gives short-form resources the manifest's types and id prefixes", () => {
    expect(parseManifest(cinemeta).resources).toEqual([
      { name: "catalog", types: ["movie", "series"], idPrefixes: ["tt"] },
      { name: "meta", types: ["movie", "series"], idPrefixes: ["tt"] },
      { name: "addon_catalog", types: ["movie", "series"], idPrefixes: ["tt"] },
    ]);
  });

  it("keeps a resource's own types and id prefixes", () => {
    // Torrentio's manifest has no top-level idPrefixes.
    expect(parseManifest(torrentio).resources).toEqual([
      { name: "stream", types: ["movie", "series", "anime"], idPrefixes: ["tt", "kitsu"] },
    ]);
    const meta = parseManifest(mediafusion).resources.find((r) => r.name === "meta");
    expect(meta).toEqual({
      name: "meta",
      types: ["movie", "series", "tv", "events"],
      idPrefixes: ["mf", "dl"],
    });
  });

  it("reads catalog extras, required ones and their options", () => {
    const catalogs = parseManifest(cinemeta).catalogs;
    const top = catalogs.find((c) => c.type === "movie" && c.id === "top");
    expect(top?.extra.map((e) => [e.name, e.isRequired])).toEqual([
      ["genre", false],
      ["search", false],
      ["skip", false],
    ]);
    expect(top?.extra[0]?.options).toContain("Drama");
    const year = catalogs.find((c) => c.type === "movie" && c.id === "year");
    expect(year?.extra[0]).toMatchObject({ name: "genre", isRequired: true });
    expect(year?.extra[0]?.options).toContain("2024");

    const lastVideos = parseManifest(kitsu).catalogs.find(
      (c) => c.id === "kitsu-anime-last-videos",
    );
    expect(lastVideos?.extra).toEqual([
      { name: "lastVideosIds", isRequired: true, optionsLimit: 20 },
    ]);
  });

  it("reads the legacy extraSupported, extraRequired and genres", () => {
    const manifest = parseManifest({
      id: "org.legacy",
      name: "Legacy",
      version: "0.1.0",
      resources: ["catalog"],
      types: ["movie"],
      catalogs: [
        {
          type: "movie",
          id: "search",
          extraSupported: ["search", "skip"],
          extraRequired: ["search"],
        },
        { type: "movie", id: "genres", genres: ["Drama", "Comedy"] },
      ],
    });
    expect(manifest.catalogs[0]?.extra).toEqual([
      { name: "search", isRequired: true },
      { name: "skip", isRequired: false },
    ]);
    expect(manifest.catalogs[1]?.extra).toEqual([
      { name: "genre", isRequired: false, options: ["Drama", "Comedy"] },
    ]);
  });

  it("reads behavior hints and keeps fields it doesn't name", () => {
    expect(parseManifest(aiostreams).behaviorHints).toEqual({
      configurable: true,
      configurationRequired: true,
    });
    expect(parseManifest(kitsu).behaviorHints).toEqual({});
    expect(parseManifest(cinemeta)["addonCatalogs"]).toEqual(cinemeta.addonCatalogs);
  });
});

describe("parseCatalogResponse", () => {
  it("reads a catalog page and its cache hints", () => {
    const page = parseCatalogResponse(cinemetaMovieTop);
    expect(page.metas).toHaveLength(cinemetaMovieTop.metas.length);
    expect(page.cacheMaxAge).toBe(cinemetaMovieTop.cacheMaxAge);
    const first = page.metas[0];
    expect(first).toMatchObject({ id: cinemetaMovieTop.metas[0]?.id, type: "movie" });
    expect(first?.poster).toMatch(/^https:/);
    // Cinemeta's own fields stay.
    expect(first?.["popularities"]).toBeDefined();
  });

  it("reads Kitsu's anime catalog, whose items have their own type", () => {
    const page = parseCatalogResponse(kitsuTrending);
    expect(page.metas.length).toBeGreaterThan(0);
    for (const meta of page.metas) {
      expect(meta.id).toMatch(/^kitsu:/);
      // An "anime" catalog lists "series" and "movie" items: ask for their
      // meta and streams by the item's type, not the catalog's.
      expect(["series", "movie"]).toContain(meta.type);
    }
  });

  it("skips items without an id or type and refuses an answer without metas", () => {
    const page = parseCatalogResponse({
      metas: [{ id: "tt1", type: "movie", name: "One" }, { name: "No id" }, "junk", null],
    });
    expect(page.metas).toEqual([{ id: "tt1", type: "movie", name: "One" }]);
    expect(() => parseCatalogResponse({ metas: null })).toThrow(InvalidAnswer);
    expect(() => parseCatalogResponse({ err: "boom" })).toThrow(InvalidAnswer);
  });
});

// A Stremio meta link, as addons list cast and crew in them.
const link = (name: string, category: string) => ({
  name,
  category,
  url: `stremio:///search?search=${name}`,
});

describe("parseMetaResponse", () => {
  it("reads a movie", () => {
    const { meta } = parseMetaResponse(cinemetaMovie);
    expect(meta).toMatchObject({ id: "tt0111161", type: "movie" });
    expect(meta.cast?.length).toBeGreaterThan(0);
    expect(meta.behaviorHints?.defaultVideoId).toBe("tt0111161");
  });

  it("reads Cinemeta's episodes, named `name`", () => {
    const { meta } = parseMetaResponse(cinemetaSeries);
    const first = meta.videos?.[0];
    expect(first).toMatchObject({ id: "tt0903747:1:1", title: "Pilot", season: 1, episode: 1 });
    expect(first?.overview).toBeTruthy();
  });

  it("reads Kitsu's episodes, named `title`", () => {
    const { meta } = parseMetaResponse(kitsuAnime);
    expect(meta.id).toBe("kitsu:46474");
    expect(meta.videos?.[0]).toMatchObject({
      id: "kitsu:46474:1",
      title: kitsuAnime.meta.videos[0]?.title,
      season: 1,
      episode: 1,
      // Kitsu's own field stays.
      absoluteEpisode: 1,
    });
  });

  it("drops fields of the wrong type and reads numbers from strings", () => {
    const { meta } = parseMetaResponse({
      meta: {
        id: "tt1",
        type: "series",
        name: 7,
        poster: { url: "x" },
        imdbRating: 8.1,
        genres: ["Drama", null, 3],
        director: "One Person",
        videos: [{ id: "tt1:1:1", season: "1", episode: "2", title: null }, { title: "No id" }],
      },
    });
    expect(meta.name).toBe("7");
    expect(meta.poster).toBeUndefined();
    expect(meta.imdbRating).toBe("8.1");
    expect(meta.genres).toEqual(["Drama"]);
    expect(meta.director).toEqual(["One Person"]);
    expect(meta.videos).toEqual([{ id: "tt1:1:1", title: "", season: 1, episode: 2 }]);
  });

  it("reads cast and crew from links when the arrays are missing", () => {
    const { meta } = parseMetaResponse({
      meta: {
        id: "tt0974015",
        type: "movie",
        name: "Justice League",
        links: [
          link("Ben Affleck", "Cast"),
          link("Gal Gadot", "Cast"),
          link("Ben Affleck", "Cast"),
          link("Zack Snyder", "Directors"),
          link("Chris Terrio", "Writers"),
          link("Action", "Genres"),
        ],
      },
    });
    expect(meta.cast).toEqual(["Ben Affleck", "Gal Gadot"]);
    expect(meta.director).toEqual(["Zack Snyder"]);
    expect(meta.writer).toEqual(["Chris Terrio"]);

    // The arrays win when an addon sends both, as Cinemeta does.
    const both = parseMetaResponse({
      meta: {
        id: "tt1",
        type: "movie",
        name: "x",
        director: ["A"],
        links: [link("B", "Directors")],
      },
    }).meta;
    expect(both.director).toEqual(["A"]);

    // An empty array doesn't hide the links.
    const empty = parseMetaResponse({
      meta: { id: "tt1", type: "movie", name: "x", cast: [], links: [link("C", "Cast")] },
    }).meta;
    expect(empty.cast).toEqual(["C"]);
  });

  it("refuses an answer without a meta", () => {
    expect(() => parseMetaResponse({ meta: null })).toThrow(InvalidAnswer);
    expect(() => parseMetaResponse({ meta: { name: "No id" } })).toThrow(InvalidAnswer);
  });
});

describe("parseStreamResponse", () => {
  it("copies Torrentio's and TorrentsDB's `title` to description", () => {
    for (const answer of [torrentioStreams, torrentsdbStreams]) {
      const { streams } = parseStreamResponse(answer);
      expect(streams.length).toBeGreaterThan(0);
      for (const stream of streams) {
        expect(stream.description).toBeTruthy();
        expect(stream.description).toBe(stream.title);
      }
    }
    const first = parseStreamResponse(torrentioStreams).streams[0];
    expect(first?.infoHash).toMatch(/^[0-9a-f]{40}$/);
    expect(first?.behaviorHints?.filename).toBe("Breaking Bad  S01E01  Pilot.mkv");
  });

  it("keeps Peerflix's non-standard fields", () => {
    const first = parseStreamResponse(peerflixStreams).streams[0];
    expect(first).toMatchObject({
      language: "es",
      quality: "4K",
      seed: 59,
      sizebytes: 33017561088,
    });
    expect(first?.sources?.at(-1)).toMatch(/^dht:/);
  });

  it("reads Comet's description and behavior hints", () => {
    const first = parseStreamResponse(cometStreams).streams[0];
    expect(first?.title).toBeUndefined();
    expect(first?.description).toContain("REMUX");
    expect(first?.behaviorHints?.videoSize).toBe(74847383334);
    expect(first?.url).toMatch(/^https:/);
  });

  it("keeps description over title, and drops what isn't an object", () => {
    const { streams } = parseStreamResponse({
      streams: [
        { title: "old", description: "new", fileIdx: "2" },
        "junk",
        {
          url: "https://cdn.example/file.mkv",
          behaviorHints: { videoSize: "1024", proxyHeaders: { request: { Referer: "x", Bad: 1 } } },
        },
      ],
    });
    expect(streams).toEqual([
      { title: "old", description: "new", fileIdx: 2 },
      {
        url: "https://cdn.example/file.mkv",
        behaviorHints: { videoSize: 1024, proxyHeaders: { request: { Referer: "x" } } },
      },
    ]);
    expect(() => parseStreamResponse({})).toThrow(InvalidAnswer);
  });
});

describe("parseSubtitlesResponse", () => {
  it("reads OpenSubtitles' answer", () => {
    const { subtitles, cacheMaxAge } = parseSubtitlesResponse(opensubtitlesMovie);
    expect(subtitles).toHaveLength(opensubtitlesMovie.subtitles.length);
    expect(subtitles[0]).toMatchObject({ id: "30949", lang: "eng" });
    expect(subtitles[0]?.url).toMatch(/^https:/);
    expect(cacheMaxAge).toBe(opensubtitlesMovie.cacheMaxAge);
  });

  it("skips subtitles without a url or language, and uses the url as a missing id", () => {
    const { subtitles } = parseSubtitlesResponse({
      subtitles: [
        { url: "https://subs.example/1.srt", lang: "eng" },
        { url: "https://subs.example/2.srt" },
      ],
    });
    expect(subtitles).toEqual([
      { id: "https://subs.example/1.srt", url: "https://subs.example/1.srt", lang: "eng" },
    ]);
  });
});
