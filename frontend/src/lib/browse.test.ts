import { describe, expect, it } from "vite-plus/test";

import type { LoadedAddon, Manifest } from "@/lib/addon-protocol";
import { parseManifest } from "@/lib/addon-protocol/parse";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import kitsuManifest from "@/lib/addon-protocol/fixtures/kitsu/manifest.json";
import {
  browseCatalogs,
  browseSearch,
  canPage,
  catalogFilter,
  isAnimeCatalog,
  type BrowseKind,
} from "@/lib/browse";

const loaded = (url: string, manifest: unknown): LoadedAddon => ({
  url,
  manifest: parseManifest(manifest),
});
const cinemeta = loaded("https://v3-cinemeta.strem.io/manifest.json", cinemetaManifest);
const kitsu = loaded("https://anime-kitsu.strem.fun/manifest.json", kitsuManifest);

// An anime addon whose catalogs are typed "series" and "movie", as MAL
// addons publish them.
const malManifest = {
  id: "community.mal",
  name: "MAL",
  version: "1.0.0",
  types: ["series", "movie"],
  idPrefixes: ["mal_"],
  resources: ["catalog", "meta"],
  catalogs: [
    { type: "series", id: "mal-airing", name: "Airing" },
    { type: "movie", id: "mal-movies", name: "Popular" },
    { type: "series", id: "mal-popular", name: "Popular" },
  ],
};
const mal = loaded("https://mal.example/manifest.json", malManifest);

const labels = (addons: LoadedAddon[], kind: BrowseKind) =>
  browseCatalogs(addons, kind).map((c) => c.label);

describe("browseCatalogs", () => {
  it("offers a type's catalogs that need at most a genre, in addon order", () => {
    // Cinemeta's search, calendar and last-videos catalogs need extras browse
    // can't give; "New" needs a year, which its filter gives.
    expect(labels([cinemeta, kitsu], "movie")).toEqual(["Popular", "New", "Featured"]);
    expect(labels([cinemeta, kitsu], "series")).toEqual(["Popular", "New", "Featured"]);
    expect(browseCatalogs([cinemeta], "movie")[0]).toMatchObject({
      addon: cinemeta,
      catalog: { type: "movie", id: "top" },
      ref: `${cinemeta.url}|movie|top`,
    });
  });

  it("puts anime addons' catalogs on Anime only, whatever their type", () => {
    expect(labels([cinemeta, kitsu, mal], "anime")).toEqual([
      "Kitsu Trending",
      "Kitsu Top Airing",
      "Kitsu Most Popular",
      "Kitsu Highest Rated",
      "Airing · Shows",
      "Popular · Movies",
      "Popular · Shows",
    ]);
    expect(labels([cinemeta, mal], "series")).toEqual(["Popular", "New", "Featured"]);
    expect(labels([cinemeta, mal], "movie")).toEqual(["Popular", "New", "Featured"]);
  });

  it("names the addon when two catalogs read the same", () => {
    const other = loaded("https://other.example/manifest.json", {
      ...cinemetaManifest,
      id: "other",
      name: "Other",
    });
    expect(labels([cinemeta, other], "movie")).toEqual([
      "Popular · Cinemeta",
      "New · Cinemeta",
      "Featured · Cinemeta",
      "Popular · Other",
      "New · Other",
      "Featured · Other",
    ]);
  });

  it("leaves out what a kids profile may not see and addons needing setup", () => {
    const visible = browseCatalogs([cinemeta], "movie", ({ catalog }) => catalog.id !== "top");
    expect(visible.map((c) => c.label)).toEqual(["New", "Featured"]);

    const unconfigured: Manifest = {
      ...cinemeta.manifest,
      behaviorHints: { configurationRequired: true },
    };
    expect(browseCatalogs([{ url: cinemeta.url, manifest: unconfigured }], "movie")).toEqual([]);
  });
});

const source = (addon: LoadedAddon, id: string) => ({
  addon,
  catalog: addon.manifest.catalogs.find((c) => c.id === id)!,
});

describe("isAnimeCatalog", () => {
  it("goes by the catalog's type, then by the addon's id prefixes", () => {
    expect(isAnimeCatalog(source(kitsu, "kitsu-anime-trending"))).toBe(true);
    // Typed "series", but Kitsu lists only anime ids.
    expect(isAnimeCatalog(source(kitsu, "kitsu-anime-last-videos"))).toBe(true);
    expect(isAnimeCatalog(source(mal, "mal-airing"))).toBe(true);
    expect(isAnimeCatalog(source(cinemeta, "top"))).toBe(false);
  });
});

const catalog = (id: string, type = "movie") =>
  cinemeta.manifest.catalogs.find((c) => c.id === id && c.type === type)!;

describe("catalogFilter", () => {
  it("is a genre filter, or a year filter when every option is a year", () => {
    expect(catalogFilter(catalog("top"))).toMatchObject({ label: "Genre", required: false });
    expect(catalogFilter(catalog("top"))?.options).toContain("Drama");
    expect(catalogFilter(catalog("year"))).toMatchObject({ label: "Year", required: true });
    expect(catalogFilter(catalog("year"))?.options[0]).toBe("2026");
    const trending = kitsu.manifest.catalogs[0]!;
    expect(catalogFilter(trending)).toBeUndefined();
  });

  it("pages only catalogs that take skip", () => {
    expect(canPage(catalog("top"))).toBe(true);
    expect(canPage(kitsu.manifest.catalogs[0]!)).toBe(false);
  });
});

describe("browseSearch", () => {
  it("keeps only non-empty strings, and years read as numbers", () => {
    expect(browseSearch({ catalog: "a|movie|top", genre: "Drama" })).toEqual({
      catalog: "a|movie|top",
      genre: "Drama",
    });
    expect(browseSearch({ catalog: "a|movie|year", genre: 2024 })).toEqual({
      catalog: "a|movie|year",
      genre: "2024",
    });
    expect(browseSearch({ catalog: "", genre: "", other: "x" })).toEqual({});
  });
});
