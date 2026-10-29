import { describe, expect, it } from "vite-plus/test";

import aiostreams from "./fixtures/aiostreams/manifest.json";
import cinemeta from "./fixtures/cinemeta/manifest.json";
import comet from "./fixtures/comet/manifest.json";
import kitsu from "./fixtures/kitsu/manifest.json";
import mediafusion from "./fixtures/mediafusion/manifest.json";
import opensubtitles from "./fixtures/opensubtitles/manifest.json";
import peerflix from "./fixtures/peerflix/manifest.json";
import torrentio from "./fixtures/torrentio/manifest.json";
import { parseManifest } from "./parse";
import { addonsFor, catalogsAccepting, extraOptions, findCatalog, serves } from "./routing";

// The recorded addons, in an order a user might have them.
const addons = Object.entries({
  cinemeta,
  kitsu,
  torrentio,
  aiostreams,
  peerflix,
  comet,
  mediafusion,
  opensubtitles,
}).map(([name, answer]) => ({
  url: `https://${name}.example/manifest.json`,
  name,
  manifest: parseManifest(answer),
}));

const names = (list: readonly { name: string }[]) => list.map((a) => a.name);
const catalogNames = (
  list: readonly { addon: { name: string }; catalog: { type: string; id: string } }[],
) => list.map(({ addon, catalog }) => `${addon.name} ${catalog.type}/${catalog.id}`);

describe("addonsFor", () => {
  it("asks every stream addon for the title's id prefix, in the user's order", () => {
    expect(names(addonsFor(addons, "stream", "movie", "tt15239678"))).toEqual([
      "torrentio",
      "peerflix",
      "comet",
      "mediafusion",
    ]);
    // Peerflix answers only tt; Comet doesn't list the anime type.
    expect(names(addonsFor(addons, "stream", "series", "kitsu:46474:1"))).toEqual([
      "torrentio",
      "comet",
    ]);
    expect(names(addonsFor(addons, "stream", "anime", "kitsu:46474:1"))).toEqual(["torrentio"]);
  });

  it("finds the meta addon by type and id prefix", () => {
    expect(names(addonsFor(addons, "meta", "movie", "tt0111161"))).toEqual(["cinemeta"]);
    expect(names(addonsFor(addons, "meta", "series", "kitsu:46474"))).toEqual(["kitsu"]);
    expect(names(addonsFor(addons, "meta", "movie", "mf:123"))).toEqual(["mediafusion"]);
    expect(addonsFor(addons, "meta", "channel", "tt0111161")).toEqual([]);
  });

  it("finds subtitle addons", () => {
    expect(names(addonsFor(addons, "subtitles", "movie", "tt0111161"))).toEqual(["opensubtitles"]);
    expect(names(addonsFor(addons, "subtitles", "series", "kitsu:46474:1"))).toEqual(["kitsu"]);
  });
});

describe("serves", () => {
  it("answers any id when a resource has no prefixes", () => {
    const manifest = parseManifest({
      id: "org.any",
      name: "Any",
      version: "1.0.0",
      types: ["movie"],
      resources: ["stream"],
    });
    expect(serves(manifest, "stream", "movie", "anything:1")).toBe(true);
    expect(serves(manifest, "stream", "series", "anything:1")).toBe(false);
    expect(serves(manifest, "meta", "movie", "anything:1")).toBe(false);
  });

  it("answers nothing for an addon that must be configured first", () => {
    const manifest = parseManifest({
      ...torrentio,
      behaviorHints: { configurationRequired: true },
    });
    expect(serves(manifest, "stream", "movie", "tt1")).toBe(false);
  });
});

describe("catalogsAccepting", () => {
  it("gives Home and browse the catalogs that need no extras", () => {
    expect(catalogNames(catalogsAccepting(addons, []))).toEqual([
      "cinemeta movie/top",
      "cinemeta series/top",
      "cinemeta movie/imdbRating",
      "cinemeta series/imdbRating",
      "kitsu anime/kitsu-anime-trending",
      "kitsu anime/kitsu-anime-airing",
      "kitsu anime/kitsu-anime-popular",
      "kitsu anime/kitsu-anime-rating",
    ]);
  });

  it("gives search the catalogs that take a search", () => {
    expect(catalogNames(catalogsAccepting(addons, ["search"]))).toEqual([
      "cinemeta movie/top",
      "cinemeta series/top",
      "kitsu anime/kitsu-anime-list",
    ]);
  });

  it("gives a genre filter the catalogs of a type that take a genre", () => {
    expect(catalogNames(catalogsAccepting(addons, ["genre"], "movie"))).toEqual([
      "cinemeta movie/top",
      "cinemeta movie/year",
      "cinemeta movie/imdbRating",
    ]);
  });
});

describe("extraOptions and findCatalog", () => {
  it("finds the catalog Home's layout names and its genres", () => {
    const found = findCatalog(addons, "com.linvo.cinemeta", "movie", "year");
    expect(found?.addon.name).toBe("cinemeta");
    expect(extraOptions(found!.catalog, "genre")).toContain("2024");
    expect(extraOptions(found!.catalog, "search")).toEqual([]);
    expect(findCatalog(addons, "com.linvo.cinemeta", "anime", "year")).toBeUndefined();
  });
});
