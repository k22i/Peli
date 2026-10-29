import {
  InfiniteQueryObserver,
  useQueryClient,
  type InfiniteData,
  type InfiniteQueryObserverResult,
} from "@tanstack/react-query";
import { useCallback, useMemo, useRef, useSyncExternalStore } from "react";

import type { Collection, CollectionFolder } from "@bindings/store";
import {
  catalogPagesQuery,
  catalogQuery,
  findCatalog,
  type CatalogResponse,
  type CatalogSource,
  type LoadedAddon,
  type MetaPreview,
} from "@/lib/addon-protocol";
import { canPage } from "@/lib/browse";
import { catalogRef } from "@/lib/home";

// A collection folder's page (#96): the catalogs a folder made in Nuvio's
// apps names (ADR-0022), merged into one grid.

export const folderPath = "/folder/$collectionId/$folderId";

export const folderParams = (collection: Collection, folder: CollectionFolder) => ({
  collectionId: collection.id,
  folderId: folder.id,
});

export function findFolder(
  collections: readonly Collection[],
  collectionId: string,
  folderId: string,
): { collection: Collection; folder: CollectionFolder } | undefined {
  const collection = collections.find((c) => c.id === collectionId);
  const folder = collection?.folders?.find((f) => f.id === folderId);
  return collection && folder ? { collection, folder } : undefined;
}

// A folder's catalog, resolved to the addon that serves it, with the genre
// to ask it for.
export type FolderSource<A extends LoadedAddon = LoadedAddon> = CatalogSource<A> & {
  genre: string | undefined;
  // catalogRef and genre: two sources can name one catalog with two genres.
  key: string;
};

// The folder's sources the profile can ask, in the folder's order: each
// matched to a visible addon by manifest id, as Home's layout rows are.
// Skipped: one whose addon is gone, turned off or needs configuring; one a
// kids profile may not see (`visible` is CatalogVisible); one that needs an
// extra other than a genre; and a repeat. A catalog that requires a genre and
// was saved without one gets its first, as on the browse pages.
export function folderSources<A extends LoadedAddon>(
  folder: CollectionFolder,
  addons: readonly A[],
  visible: (source: CatalogSource<A>) => boolean,
): FolderSource<A>[] {
  const sources: FolderSource<A>[] = [];
  for (const saved of folder.sources ?? []) {
    const source = findCatalog(addons, saved.addonId, saved.type, saved.catalogId);
    if (!source || source.addon.manifest.behaviorHints.configurationRequired) continue;
    const genreExtra = source.catalog.extra.find((extra) => extra.name === "genre");
    const genre =
      saved.genre || (genreExtra?.isRequired ? genreExtra.options?.[0] : undefined) || undefined;
    const askable = source.catalog.extra.every(
      (extra) => !extra.isRequired || (extra.name === "genre" && genre !== undefined),
    );
    const key = `${catalogRef(source)}|${genre ?? ""}`;
    if (!askable || !visible(source) || sources.some((s) => s.key === key)) continue;
    sources.push({ ...source, genre, key });
  }
  return sources;
}

// What one source has loaded so far: its items, page after page, and whether
// more may come (it's still loading, or has another page).
export type SourceItems = { metas: readonly MetaPreview[]; more: boolean };

// The folder's grid: the sources' items taken in turn, one from each, as
// Nuvio's apps merge a folder's "All" tab, with the first copy of a title
// kept. It goes only as deep as the shallowest source that may still have
// more, so a page landing later appends to the grid rather than reshuffling
// what's on screen; a source that's done just runs out. `behind` are the
// sources holding it there, the ones to load next.
export function mergeSources(sources: readonly SourceItems[]): {
  metas: MetaPreview[];
  behind: number[];
} {
  const depth = Math.min(
    ...sources.filter((source) => source.more).map((source) => source.metas.length),
  );
  const longest = Math.max(0, ...sources.map((source) => source.metas.length));
  const seen = new Set<string>();
  const metas: MetaPreview[] = [];
  for (let i = 0; i < Math.min(depth, longest); i++) {
    for (const source of sources) {
      const meta = source.metas[i];
      if (!meta || seen.has(meta.id)) continue;
      seen.add(meta.id);
      metas.push(meta);
    }
  }
  const behind = sources.flatMap((source, i) =>
    source.more && source.metas.length === depth ? [i] : [],
  );
  return { metas, behind };
}

type PagesResult = InfiniteQueryObserverResult<InfiniteData<CatalogResponse>>;

// Each source page by page, with browse's catalogPagesQuery (#43), so a
// folder and a browse page showing the same catalog share pages, and the
// first page comes from Home's persisted cache when Home showed it. One
// observer per source: useInfiniteQuery can't take a list.
export function useFolderPages(sources: readonly FolderSource[]): PagesResult[] {
  const client = useQueryClient();
  const keys = sources.map((source) => source.key).join("\n");
  const observers = useMemo(
    () =>
      sources.map(({ addon, catalog, genre }) => {
        const extra = genre === undefined ? {} : { genre };
        const firstPage = catalogQuery(addon.url, catalog.type, catalog.id, extra).queryKey;
        return new InfiniteQueryObserver(client, {
          ...catalogPagesQuery(addon.url, catalog.type, catalog.id, {
            extra,
            paged: canPage(catalog),
          }),
          initialData: () => {
            const first = client.getQueryData(firstPage);
            return first && { pages: [first], pageParams: [0] };
          },
          initialDataUpdatedAt: () => client.getQueryState(firstPage)?.dataUpdatedAt,
        });
      }),
    // oxlint-disable-next-line react/exhaustive-deps -- `keys` names the sources.
    [client, keys],
  );
  const subscribe = useCallback(
    (onChange: () => void) => {
      const unsubscribe = observers.map((observer) => observer.subscribe(onChange));
      return () => unsubscribe.forEach((stop) => stop());
    },
    [observers],
  );
  // The same array until a result changes, as useSyncExternalStore needs.
  const last = useRef<PagesResult[]>([]);
  const snapshot = useCallback(() => {
    const results = observers.map((observer) => observer.getCurrentResult());
    if (
      results.length !== last.current.length ||
      results.some((result, i) => result !== last.current[i])
    ) {
      last.current = results;
    }
    return last.current;
  }, [observers]);
  return useSyncExternalStore(subscribe, snapshot);
}
