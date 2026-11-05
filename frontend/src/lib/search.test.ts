import { describe, expect, it } from "vite-plus/test";

import type { LoadedAddon, MetaPreview } from "@/lib/addon-protocol";
import { parseManifest } from "@/lib/addon-protocol/parse";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import kitsuManifest from "@/lib/addon-protocol/fixtures/kitsu/manifest.json";
import { groupByline, searchCatalogs, searchGroups, searchSearch, searchTerm } from "@/lib/search";

const loaded = (url: string, manifest: unknown): LoadedAddon => ({
  url,
  manifest: parseManifest(manifest),
});
const cinemeta = loaded("https://v3-cinemeta.strem.io/manifest.json", cinemetaManifest);
const kitsu = loaded("https://anime-kitsu.strem.fun/manifest.json", kitsuManifest);

const ids = (sources: ReturnType<typeof searchCatalogs>) =>
  sources.map(({ addon, catalog }) => `${addon.manifest.name}:${catalog.type}/${catalog.id}`);

const meta = (id: string, type = "movie"): MetaPreview => ({ id, type, name: id });

describe("searchCatalogs", () => {
  it("asks every catalog that takes search, in addon order", () => {
    expect(ids(searchCatalogs([kitsu, cinemeta]))).toEqual([
      "Anime Kitsu:anime/kitsu-anime-list",
      "Cinemeta:movie/top",
      "Cinemeta:series/top",
    ]);
  });

  it("leaves out catalogs a kids profile may not see", () => {
    expect(
      ids(searchCatalogs([cinemeta, kitsu], ({ catalog }) => catalog.type !== "series")),
    ).toEqual(["Cinemeta:movie/top", "Anime Kitsu:anime/kitsu-anime-list"]);
  });

  it("skips addons that must be configured first", () => {
    const unconfigured = loaded("https://x.example/manifest.json", {
      ...cinemetaManifest,
      behaviorHints: { configurationRequired: true },
    });
    expect(searchCatalogs([unconfigured])).toEqual([]);
  });
});

describe("searchTerm", () => {
  it("waits for two characters and tidies spaces", () => {
    expect(searchTerm(undefined)).toBeUndefined();
    expect(searchTerm(" d ")).toBeUndefined();
    expect(searchTerm("  up ")).toBe("up");
    expect(searchTerm("star   wars")).toBe("star wars");
  });
});

describe("searchSearch", () => {
  it("keeps a query, as text even when it's a number", () => {
    expect(searchSearch({ q: "dune" })).toEqual({ q: "dune" });
    expect(searchSearch({ q: 1917 })).toEqual({ q: "1917" });
    expect(searchSearch({ q: "  " })).toEqual({});
    expect(searchSearch({})).toEqual({});
  });
});

describe("searchGroups", () => {
  const [movies, series] = searchCatalogs([cinemeta]);
  const [anime] = searchCatalogs([kitsu]);

  it("groups Movies, Shows and Anime in that order, whoever answered", () => {
    const groups = searchGroups([
      { source: anime!, metas: [meta("kitsu:1", "series")] },
      { source: series!, metas: [meta("tt2", "series")] },
      { source: movies!, metas: [meta("tt1")] },
    ]);
    expect(groups.map((group) => [group.title, group.metas.map((m) => m.id)])).toEqual([
      ["Movies", ["tt1"]],
      ["Shows", ["tt2"]],
      ["Anime", ["kitsu:1"]],
    ]);
  });

  it("shows a title once, where the first catalog put it", () => {
    const groups = searchGroups([
      { source: movies!, metas: [meta("tt1"), meta("tt2")] },
      { source: series!, metas: [meta("tt2", "series"), meta("tt3", "series")] },
    ]);
    expect(groups.map((group) => group.metas.map((m) => m.id))).toEqual([["tt1", "tt2"], ["tt3"]]);
  });

  it("leaves general catalogs' anime to the anime catalogs (#109)", () => {
    const groups = searchGroups(
      [
        { source: series!, metas: [meta("tt2", "series"), meta("tt3", "series")] },
        { source: anime!, metas: [meta("kitsu:1", "series"), meta("tt2", "series")] },
      ],
      (id) => id === "tt2",
    );
    expect(groups.map((group) => [group.title, group.metas.map((m) => m.id)])).toEqual([
      ["Shows", ["tt3"]],
      ["Anime", ["kitsu:1", "tt2"]],
    ]);
  });

  it("puts other types last and skips catalogs that haven't answered", () => {
    const groups = searchGroups([
      { source: movies!, metas: [meta("ch1", "channel"), meta("tt1")] },
      { source: series! },
    ]);
    expect(groups.map((group) => group.title)).toEqual(["Movies", "Channels"]);
  });
});

describe("searchGroups addons", () => {
  const [movies, series] = searchCatalogs([cinemeta]);
  const [anime] = searchCatalogs([kitsu]);

  it("names the addons that gave a group's results, in addon order", () => {
    const groups = searchGroups([
      { source: movies!, metas: [meta("tt1")] },
      { source: anime!, metas: [meta("kitsu:1", "series")] },
      { source: series!, metas: [] },
    ]);
    expect(groups.map((group) => [group.title, group.addons])).toEqual([
      ["Movies", ["Cinemeta"]],
      ["Anime", ["Anime Kitsu"]],
    ]);
  });
});

describe("groupByline", () => {
  it("lists one or two addons, and counts the rest", () => {
    expect(groupByline(["Cinemeta"])).toBe("Cinemeta");
    expect(groupByline(["Cinemeta", "Kitsu"])).toBe("Cinemeta and Kitsu");
    expect(groupByline(["Cinemeta", "Kitsu", "MAL", "TMDB"])).toBe("Cinemeta +3");
  });
});
