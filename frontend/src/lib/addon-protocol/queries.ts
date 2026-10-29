import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";

import { addonClient, type AddonClient } from "./client";
import type { CacheHints, CatalogResponse, ContentType, Extra } from "./types";

// TanStack Query options for every addon request, so each feature shares one
// cache: Home, browse, search and the title page (#40) read catalogs and
// metas, the stream picker (#50) streams, the player (#63) subtitles.
// Leaving a screen cancels its requests (the query's signal).

const minute = 60 * 1000;
const hour = 60 * minute;
const day = 24 * hour;

// Fresh for as long as the addon's cacheMaxAge says, kept within limits, or
// for `fallback`.
export function freshFor(data: CacheHints | undefined, fallback: number): number {
  const maxAge = data?.cacheMaxAge;
  if (maxAge === undefined || maxAge <= 0) return fallback;
  return Math.min(Math.max(maxAge * 1000, minute), day);
}

// An addon's manifest, from the addon. Kept across restarts so Home can
// route its rows from cache (#42). One that fails to load is shown with its
// error and stays installed: dropping it would delete it on every device at
// the next push (#32).
export const manifestQuery = (url: string, client: AddonClient = addonClient) =>
  queryOptions({
    queryKey: ["addon-manifest", url],
    queryFn: ({ signal }) => client.manifest(url, { signal }),
    staleTime: hour,
    retry: 1,
    meta: { persist: true },
  });

// One page of a catalog. Kept across restarts, so Home renders from cache
// while fresh rows load (#42).
export const catalogQuery = (
  addonUrl: string,
  type: ContentType,
  id: string,
  extra: Extra = {},
  client: AddonClient = addonClient,
) =>
  queryOptions({
    queryKey: ["addon-catalog", addonUrl, type, id, extra],
    queryFn: ({ signal }) => client.catalog(addonUrl, type, id, extra, { signal }),
    staleTime: (query) => freshFor(query.state.data, hour),
    retry: 1,
    meta: { persist: true },
  });

// A catalog page by page, for browse's infinite scroll (#43). The first page
// is catalogQuery's, so it comes from the persisted cache and lands back in
// it; the rest are asked with `skip` set to the items so far, as Stremio's
// apps do, and aren't kept on disk. Paging stops at an empty page or
// `hasMore: false`, and never starts for a catalog that doesn't take
// `skip`.
export const catalogPagesQuery = (
  addonUrl: string,
  type: ContentType,
  id: string,
  { extra = {}, paged }: { extra?: Extra; paged: boolean },
  client: AddonClient = addonClient,
) =>
  infiniteQueryOptions({
    queryKey: ["addon-catalog-pages", addonUrl, type, id, extra],
    queryFn: ({ pageParam, signal, client: queryClient }) =>
      pageParam === 0
        ? queryClient.fetchQuery(catalogQuery(addonUrl, type, id, extra, client))
        : client.catalog(addonUrl, type, id, { ...extra, skip: pageParam }, { signal }),
    initialPageParam: 0,
    getNextPageParam: (last: CatalogResponse, all: CatalogResponse[]) =>
      paged && last.metas.length > 0 && last.hasMore !== false
        ? all.reduce((count, page) => count + page.metas.length, 0)
        : undefined,
    staleTime: (query) => freshFor(query.state.data?.pages[0], hour),
    retry: 1,
  });

// One search catalog's results for `query` (#44). Each catalog is its own
// query, so its results show as soon as its addon answers. Kept in memory
// only, since a search isn't worth a slot on disk; not retried, so a slow
// addon's error shows rather than doubling its wait.
export const searchQuery = (
  addonUrl: string,
  type: ContentType,
  id: string,
  query: string,
  client: AddonClient = addonClient,
) =>
  queryOptions({
    queryKey: ["addon-search", addonUrl, type, id, query],
    queryFn: ({ signal }) => client.catalog(addonUrl, type, id, { search: query }, { signal }),
    staleTime: 5 * minute,
    retry: false,
  });

// A title's meta from one addon. Kept across restarts for the title page.
export const metaQuery = (
  addonUrl: string,
  type: ContentType,
  id: string,
  client: AddonClient = addonClient,
) =>
  queryOptions({
    queryKey: ["addon-meta", addonUrl, type, id],
    queryFn: ({ signal }) => client.meta(addonUrl, type, id, { signal }),
    staleTime: (query) => freshFor(query.state.data, hour),
    retry: 1,
    meta: { persist: true },
  });

// One addon's streams for a title or episode. Never kept on disk, since
// debrid links embed the user's key and expire; not retried, so a slow
// addon's error shows rather than doubling its wait (#50).
export const streamsQuery = (
  addonUrl: string,
  type: ContentType,
  id: string,
  client: AddonClient = addonClient,
) =>
  queryOptions({
    queryKey: ["addon-streams", addonUrl, type, id],
    queryFn: ({ signal }) => client.streams(addonUrl, type, id, { signal }),
    staleTime: 5 * minute,
    gcTime: 30 * minute,
    retry: false,
  });

// One addon's subtitles for a video. Not kept on disk.
export const subtitlesQuery = (
  addonUrl: string,
  type: ContentType,
  id: string,
  extra: Extra = {},
  client: AddonClient = addonClient,
) =>
  queryOptions({
    queryKey: ["addon-subtitles", addonUrl, type, id, extra],
    queryFn: ({ signal }) => client.subtitles(addonUrl, type, id, extra, { signal }),
    staleTime: hour,
    gcTime: hour,
    retry: 1,
  });
