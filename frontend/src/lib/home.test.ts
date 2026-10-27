import { describe, expect, it } from "vite-plus/test";

import type { Collection, HomeLayout, HomeRow } from "@bindings/store";
import { homeSections } from "@/lib/home";

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
