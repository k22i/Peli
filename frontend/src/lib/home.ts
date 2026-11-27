import { keepPreviousData, queryOptions, useQueries, useQuery } from "@tanstack/react-query";

import type { Collection, HomeLayout } from "@bindings/store";
import { Service as Store } from "@bindings/store";
import {
  catalogsAccepting,
  findCatalog,
  manifestQuery,
  type Catalog,
  type CatalogSource,
  type LoadedAddon,
  type MetaPreview,
} from "@/lib/addon-protocol";
import { visibleAddonsQuery } from "@/lib/addons";
import { profileKnown } from "@/lib/profile";

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
// layout doesn't name. A layout row for a collection that no longer exists
// is skipped; homeRows resolves the catalogs.
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

// A catalog, as CatalogVisible and the layout name it.
export const catalogRef = ({ addon, catalog }: CatalogSource) =>
  `${addon.url}|${catalog.type}|${catalog.id}`;

// Which of these catalogs the profile may see, by catalogRef: a kids
// profile only the ones its parent allowed (ADR-0014), anyone else all of
// them. Under the visible addons' key, so an edit, a pull or a change of
// allow-list refreshes it; the last answer stays up while a new one loads.
export const catalogVisibilityQuery = (profileId: number, sources: readonly CatalogSource[]) =>
  queryOptions({
    queryKey: ["addons", profileId, "visible", "catalogs", sources.map(catalogRef)],
    queryFn: async () => {
      const shown = await Promise.all(
        sources.map(({ addon, catalog }) =>
          Store.CatalogVisible(profileId, addon.url, catalog.type, catalog.id),
        ),
      );
      return new Map(sources.map((source, i) => [catalogRef(source), shown[i] === true]));
    },
    placeholderData: keepPreviousData,
  });

// A profile's visible addons whose manifests loaded, in the user's order;
// one that fails to load drops out and stays installed. `loading` is true
// until every manifest has answered. The title page (#45) needs only these.
export function useLoadedAddons(profileId: number) {
  // Nothing to ask until the store has named the profile (profileKnown): the
  // player mounts before CurrentProfile answers after a webview reload, and
  // asking about 0 is refused.
  const visible = useQuery({
    ...visibleAddonsQuery(profileId),
    enabled: profileKnown(profileId),
  });
  const manifests = useQueries({
    queries: (visible.data ?? []).map((addon) => manifestQuery(addon.url)),
  });
  const addons: LoadedAddon[] = (visible.data ?? []).flatMap((addon, index) => {
    const manifest = manifests[index]?.data;
    return manifest ? [{ url: addon.url, manifest }] : [];
  });
  return {
    visible,
    addons,
    loading: visible.isPending || manifests.some((query) => query.isPending),
  };
}

// The addons a profile browses with, for Home, the browse pages and Search:
// the visible ones whose manifests loaded, in the user's order (one that
// fails to load drops out and stays installed), and `shown`, which tells
// whether a kids profile may see a catalog. `shown` fails closed: a catalog
// CatalogVisible hasn't answered for yet, such as one whose manifest just
// loaded while the last answer is still up, isn't shown, and isn't asked.
// `loading` is true until every catalog has its answer.
export function useBrowsableAddons(profileId: number) {
  const { visible, addons, loading: manifestsLoading } = useLoadedAddons(profileId);
  const sources = addons.flatMap((addon) =>
    addon.manifest.catalogs.map((catalog) => ({ addon, catalog })),
  );
  const visibility = useQuery(catalogVisibilityQuery(profileId, sources)).data;
  return {
    visible,
    addons,
    shown: (source: CatalogSource) => visibility?.get(catalogRef(source)) === true,
    loading:
      manifestsLoading ||
      !visibility ||
      sources.some((source) => !visibility.has(catalogRef(source))),
  };
}

const layoutKey = (addonId: string, type: string, catalogId: string) =>
  `${addonId}:${type}:${catalogId}`;

// A row of Home below Continue Watching once the addons have loaded: a
// collection, or a catalog resolved to the addon that serves it.
export type HomeRowOf<A extends LoadedAddon> =
  | Extract<HomeSection, { kind: "collection" }>
  | {
      kind: "catalog";
      key: string;
      // The user's title for the row, or the catalog's name and type.
      title: string;
      source: CatalogSource<A>;
    };

// How many titles a catalog row on Home shows (#113): big cards (1.5×) keep
// the page light, and "Browse all" opens the rest. Rows without a browse
// page keep all of theirs.
export const homeRowLimit = 10;

// Home's rows in the user's order (#42): the sections of the layout, with
// each catalog matched to an addon by manifest id, then the catalogs the
// layout doesn't name, in addon order. `addons` are the profile's visible
// addons whose manifests loaded, in order; `visible` is CatalogVisible, so a
// kids profile sees only the catalogs its parent allowed. Catalogs turned off
// in the layout stay off, and ones that need extras (search, calendars) are
// browse's and search's.
export function homeRows<A extends LoadedAddon>(
  layout: HomeLayout | null | undefined,
  collections: readonly Collection[],
  addons: readonly A[],
  visible: (source: CatalogSource<A>) => boolean,
): HomeRowOf<A>[] {
  const placed = new Set(
    (layout?.rows ?? [])
      .filter((row) => !row.enabled && row.addonId && row.type && row.catalogId)
      .map((row) => layoutKey(row.addonId!, row.type!, row.catalogId!)),
  );
  const rows: HomeRowOf<A>[] = [];
  const add = (source: CatalogSource<A>, key: string, title?: string) => {
    const catalogKey = layoutKey(source.addon.manifest.id, source.catalog.type, source.catalog.id);
    if (placed.has(catalogKey) || !visible(source)) return;
    placed.add(catalogKey);
    rows.push({ kind: "catalog", key, title: title || catalogTitle(source.catalog), source });
  };

  for (const section of homeSections(layout, collections)) {
    if (section.kind === "collection") {
      rows.push(section);
      continue;
    }
    const source = findCatalog(addons, section.addonId, section.type, section.catalogId);
    if (source) add(source, section.key, section.title);
  }
  for (const source of catalogsAccepting(addons, [])) {
    add(source, layoutKey(source.addon.manifest.id, source.catalog.type, source.catalog.id));
  }
  return rows;
}

const typeNames: Record<string, string> = {
  movie: "Movies",
  series: "Shows",
  anime: "Anime",
  channel: "Channels",
  tv: "TV",
};

// A content type as the app names it: "series" is Shows.
export const typeName = (type: string) =>
  typeNames[type] ?? type.charAt(0).toUpperCase() + type.slice(1);

// "Popular · Movies": Cinemeta names its movie and series catalogs alike.
export function catalogTitle(catalog: Catalog): string {
  const type = typeName(catalog.type);
  return catalog.name ? `${catalog.name} · ${type}` : type;
}

// Whether a catalog item is out, for the layout's "hide unreleased content".
// One with no release date counts as out.
export function isReleased(meta: MetaPreview, now = Date.now()): boolean {
  if (meta.released === undefined) return true;
  const released = Date.parse(meta.released);
  return Number.isNaN(released) || released <= now;
}
