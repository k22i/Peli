import { describe, expect, it } from "vite-plus/test";

import type { Collection, CollectionFolder, CollectionSource } from "@bindings/store";
import type { CatalogSource, LoadedAddon, MetaPreview } from "@/lib/addon-protocol";
import { parseManifest } from "@/lib/addon-protocol/parse";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import kitsuManifest from "@/lib/addon-protocol/fixtures/kitsu/manifest.json";
import { findFolder, folderSources, mergeSources } from "@/lib/folder";

const loaded = (url: string, manifest: unknown): LoadedAddon => ({
  url,
  manifest: parseManifest(manifest),
});
const cinemeta = loaded("https://v3-cinemeta.strem.io/manifest.json", cinemetaManifest);
const kitsu = loaded("https://anime-kitsu.strem.fun/manifest.json", kitsuManifest);

const folder = (...sources: CollectionSource[]): CollectionFolder => ({
  id: "f1",
  title: "Picks",
  hideTitle: false,
  sources,
});
const source = (addonId: string, type: string, catalogId: string, genre?: string) => ({
  addonId,
  type,
  catalogId,
  ...(genre ? { genre } : {}),
});
const names = (sources: readonly (CatalogSource & { genre: string | undefined })[]) =>
  sources.map(({ catalog, genre }) => `${catalog.type}/${catalog.id}${genre ? `/${genre}` : ""}`);

describe("findFolder", () => {
  const collection: Collection = {
    id: "c1",
    title: "Streaming",
    pinToTop: false,
    folders: [folder()],
  };

  it("finds a folder by its collection's id and its own", () => {
    expect(findFolder([collection], "c1", "f1")?.folder.title).toBe("Picks");
    expect(findFolder([collection], "c2", "f1")).toBeUndefined();
    expect(findFolder([collection], "c1", "f2")).toBeUndefined();
    expect(findFolder([{ ...collection, folders: null }], "c1", "f1")).toBeUndefined();
  });
});

describe("folderSources", () => {
  it("resolves sources by manifest id, in the folder's order, with their genres", () => {
    const sources = folderSources(
      folder(
        source("community.anime.kitsu", "anime", "kitsu-anime-airing"),
        source("com.linvo.cinemeta", "movie", "top", "Drama"),
        source("com.linvo.cinemeta", "series", "top"),
      ),
      [cinemeta, kitsu],
      () => true,
    );
    expect(names(sources)).toEqual(["anime/kitsu-anime-airing", "movie/top/Drama", "series/top"]);
    expect(sources[1]!.addon).toBe(cinemeta);
  });

  it("skips gone, hidden and unaskable sources, and repeats", () => {
    const sources = folderSources(
      folder(
        source("org.gone", "movie", "top"),
        source("com.linvo.cinemeta", "movie", "missing"),
        // Needs a search query.
        source("community.anime.kitsu", "anime", "kitsu-anime-list"),
        // Hidden from this kids profile.
        source("community.anime.kitsu", "anime", "kitsu-anime-popular"),
        source("com.linvo.cinemeta", "movie", "top"),
        source("com.linvo.cinemeta", "movie", "top"),
        source("com.linvo.cinemeta", "movie", "top", "Drama"),
      ),
      [cinemeta, kitsu],
      ({ catalog }) => catalog.id !== "kitsu-anime-popular",
    );
    expect(names(sources)).toEqual(["movie/top", "movie/top/Drama"]);
  });

  it("gives a catalog that requires a genre its first when none was saved", () => {
    const [year] = folderSources(
      folder(source("com.linvo.cinemeta", "movie", "year")),
      [cinemeta],
      () => true,
    );
    expect(year?.genre).toBe(
      cinemeta.manifest.catalogs.find((c) => c.id === "year")!.extra[0]!.options![0],
    );
  });

  it("skips an addon that needs configuring", () => {
    const unconfigured = loaded("https://aio.example/stremio/manifest.json", {
      ...cinemetaManifest,
      behaviorHints: { configurable: true, configurationRequired: true },
    });
    expect(
      folderSources(
        folder(source("com.linvo.cinemeta", "movie", "top")),
        [unconfigured],
        () => true,
      ),
    ).toEqual([]);
  });
});

const metas = (...ids: string[]): MetaPreview[] =>
  ids.map((id) => ({ id, type: "movie", name: id }));
const ids = (merged: { metas: MetaPreview[] }) => merged.metas.map((meta) => meta.id);

describe("mergeSources", () => {
  it("takes one from each source in turn, keeping the first copy", () => {
    const merged = mergeSources([
      { metas: metas("a1", "a2", "both"), more: false },
      { metas: metas("both", "b2"), more: false },
    ]);
    expect(ids(merged)).toEqual(["a1", "both", "a2", "b2"]);
    expect(merged.behind).toEqual([]);
  });

  it("waits for a source that's still loading", () => {
    const merged = mergeSources([
      { metas: metas("a1", "a2"), more: false },
      { metas: [], more: true },
    ]);
    expect(ids(merged)).toEqual([]);
    expect(merged.behind).toEqual([1]);
  });

  it("goes only as deep as the shallowest source with more", () => {
    const sources = [
      { metas: metas("a1", "a2", "a3", "a4"), more: true },
      { metas: metas("b1", "b2"), more: true },
      { metas: metas("c1"), more: false },
    ];
    const merged = mergeSources(sources);
    expect(ids(merged)).toEqual(["a1", "b1", "c1", "a2", "b2"]);
    expect(merged.behind).toEqual([1]);

    // B's next page only appends.
    const next = mergeSources([
      sources[0]!,
      { metas: metas("b1", "b2", "b3"), more: false },
      sources[2]!,
    ]);
    expect(ids(next)).toEqual(["a1", "b1", "c1", "a2", "b2", "a3", "b3", "a4"]);
    expect(next.behind).toEqual([0]);
  });
});
