import { describe, expect, it } from "vite-plus/test";

import type { Collection, HomeLayout, HomeRow } from "@bindings/store";
import type { LoadedAddon, Manifest, MetaPreview } from "@/lib/addon-protocol";
import { parseManifest } from "@/lib/addon-protocol/parse";
import cinemetaManifest from "@/lib/addon-protocol/fixtures/cinemeta/manifest.json";
import { homeRows, homeSections, isReleased } from "@/lib/home";

const collection = (id: string, pinToTop = false): Collection => ({
  id,
  title: id,
  pinToTop,
  folders: [],
});
const catalog = (catalogId: string, enabled = true, title = ""): HomeRow => ({
  key: `org.cinemeta:movie:${catalogId}`,
  addonId: "org.cinemeta",
  type: "movie",
  catalogId,
  enabled,
  title,
});
const collectionRow = (id: string, enabled = true): HomeRow => ({
  key: `collection_${id}`,
  collectionId: id,
  enabled,
});

const keys = (layout: HomeLayout | null, collections: Collection[]) =>
  homeSections(layout, collections).map((s) => s.key);

describe("homeSections", () => {
  it("follows the layout, with pinned collections first and unnamed ones last", () => {
    const layout: HomeLayout = {
      rows: [
        catalog("top", true, "Popular"),
        collectionRow("anime"),
        catalog("hidden", false),
        collectionRow("gone"),
        collectionRow("off", false),
      ],
      hideUnreleased: false,
    };
    const collections = [
      collection("anime"),
      collection("pinned", true),
      collection("new"),
      collection("off"),
    ];
    expect(keys(layout, collections)).toEqual([
      "collection_pinned",
      "org.cinemeta:movie:top",
      "collection_anime",
      "collection_new",
    ]);
    expect(homeSections(layout, collections)[1]).toMatchObject({
      kind: "catalog",
      addonId: "org.cinemeta",
      catalogId: "top",
      title: "Popular",
    });
  });

  it("shows every collection when there is no layout", () => {
    expect(keys(null, [collection("a"), collection("b")])).toEqual([
      "collection_a",
      "collection_b",
    ]);
  });

  it("doesn't pin a collection the layout turned off", () => {
    const layout: HomeLayout = { rows: [collectionRow("p", false)], hideUnreleased: false };
    expect(keys(layout, [collection("p", true)])).toEqual([]);
  });
});

describe("homeRows", () => {
  const cinemeta: LoadedAddon = {
    url: "https://cinemeta.test/manifest.json",
    manifest: parseManifest(cinemetaManifest),
  };
  const kitsu: LoadedAddon = {
    url: "https://kitsu.test/manifest.json",
    manifest: {
      ...cinemeta.manifest,
      id: "org.kitsu",
      catalogs: [{ type: "anime", id: "trending", name: "Trending", extra: [] }],
    } satisfies Manifest,
  };
  const cinemetaRow = (catalogId: string, enabled = true, title = "") => ({
    ...catalog(catalogId, enabled, title),
    addonId: cinemeta.manifest.id,
  });
  const titles = (layout: HomeLayout | null, visible = () => true) =>
    homeRows(layout, [collection("anime")], [cinemeta, kitsu], visible).map((row) =>
      row.kind === "catalog" ? row.title : `collection ${row.collection.title}`,
    );

  it("follows the layout, then adds the catalogs it doesn't name in addon order", () => {
    const layout: HomeLayout = {
      rows: [
        { ...catalog("top", true, "Top films"), addonId: "org.kitsu", type: "anime" },
        { ...catalog("trending"), addonId: "org.kitsu", type: "anime" },
        collectionRow("anime"),
        cinemetaRow("imdbRating", false),
        cinemetaRow("missing"),
      ],
      hideUnreleased: false,
    };
    // Cinemeta's "New" catalogs need a genre and its video catalogs ids:
    // they're browse's, not Home's.
    expect(titles(layout)).toEqual([
      "Trending · Anime",
      "collection anime",
      "Popular · Movies",
      "Popular · Shows",
      "Featured · Shows",
    ]);
  });

  it("uses the user's title for a row", () => {
    expect(titles({ rows: [cinemetaRow("top", true, "Films")], hideUnreleased: false })[0]).toBe(
      "Films",
    );
  });

  it("leaves out what CatalogVisible hides, and every catalog with no layout", () => {
    expect(titles(null, () => false)).toEqual(["collection anime"]);
    expect(titles(null)).toHaveLength(6);
  });
});

const meta = (released?: string): MetaPreview => ({
  id: "tt1",
  type: "movie",
  name: "Low Tide",
  ...(released !== undefined && { released }),
});

describe("isReleased", () => {
  const now = Date.parse("2026-10-29T00:00:00Z");
  it("is out once its release date has passed, or with none", () => {
    expect(isReleased(meta("2026-07-10T00:00:00.000Z"), now)).toBe(true);
    expect(isReleased(meta("2027-01-01T00:00:00.000Z"), now)).toBe(false);
    expect(isReleased(meta(), now)).toBe(true);
    expect(isReleased(meta("soon"), now)).toBe(true);
  });
});
