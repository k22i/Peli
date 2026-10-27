import { queryOptions } from "@tanstack/react-query";

import type { Collection, HomeLayout } from "@bindings/store";
import { Service as Store } from "@bindings/store";

// Home's layout and collections, pulled from Nuvio's apps (#35) and read
// from the local store, so they show offline. Keyed under the surfaces'
// prefixes in lib/sync.ts, so a pull refreshes them.
export const homeLayoutQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["home-layout", profileId],
    queryFn: () => Store.HomeLayout(profileId),
  });

export const collectionsQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["collections", profileId],
    queryFn: async () => (await Store.Collections(profileId)) ?? [],
  });

// A row of Home below Continue Watching: an addon's catalog, by the addon's
// manifest id, or a collection.
export type HomeSection =
  | {
      kind: "catalog";
      key: string;
      addonId: string;
      type: string;
      catalogId: string;
      // The title the user gave the row; otherwise the catalog's own.
      title?: string | undefined;
    }
  | { kind: "collection"; key: string; collection: Collection };

// The order of Home's rows, as Nuvio's apps set it: collections pinned to
// the top, then the layout's rows that are turned on, then collections the
// layout doesn't name. Catalogs the layout doesn't name are the catalog
// rows' to add after these, in addon order (#42); a layout row for a
// collection that no longer exists is skipped.
export function homeSections(
  layout: HomeLayout | null | undefined,
  collections: readonly Collection[],
): HomeSection[] {
  const rows = layout?.rows ?? [];
  const off = new Set(rows.filter((row) => !row.enabled).map((row) => row.collectionId));
  const byId = new Map(collections.map((c) => [c.id, c]));
  const placed = new Set<string>();
  const sections: HomeSection[] = [];
  const addCollection = (collection: Collection) => {
    if (placed.has(collection.id) || off.has(collection.id)) return;
    placed.add(collection.id);
    sections.push({ kind: "collection", key: `collection_${collection.id}`, collection });
  };

  for (const collection of collections) {
    if (collection.pinToTop) addCollection(collection);
  }
  for (const row of rows) {
    if (!row.enabled) continue;
    if (row.collectionId) {
      const collection = byId.get(row.collectionId);
      if (collection) addCollection(collection);
    } else if (row.addonId && row.type && row.catalogId) {
      sections.push({
        kind: "catalog",
        key: row.key,
        addonId: row.addonId,
        type: row.type,
        catalogId: row.catalogId,
        title: row.title || undefined,
      });
    }
  }
  for (const collection of collections) addCollection(collection);
  return sections;
}
