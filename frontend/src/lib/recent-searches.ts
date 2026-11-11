import { queryOptions, useQuery, useQueryClient } from "@tanstack/react-query";

import { Service as Store } from "@bindings/store";

// The last few searches, per profile, on this device. They live in the Go
// store (webview storage is for the theme only), and the list shows what was
// last saved: a failed save just leaves the previous list.

export const recentLimit = 8;

export const recentSearchesQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["recent-searches", profileId],
    queryFn: () => Store.RecentSearches(profileId),
    staleTime: Number.POSITIVE_INFINITY,
  });

// Newest first, once each (a repeat moves up, whatever its case).
export function withRecent(list: readonly string[], term: string): string[] {
  return [term, ...list.filter((r) => r.toLowerCase() !== term.toLowerCase())].slice(
    0,
    recentLimit,
  );
}

export const withoutRecent = (list: readonly string[], term: string) =>
  list.filter((r) => r !== term);

// `undefined` while the profile loads: nothing to show or save yet.
export function useRecentSearches(profileId: number | undefined) {
  const client = useQueryClient();
  const options = recentSearchesQuery(profileId ?? 0);
  const { queryKey } = options;
  const list = useQuery({ ...options, enabled: profileId !== undefined }).data ?? [];

  const save = (next: string[]) => {
    if (profileId === undefined) return;
    // Shown at once; the store has the last word if it refuses.
    client.setQueryData(queryKey, next);
    Store.SetRecentSearches(profileId, next).catch(() => client.invalidateQueries({ queryKey }));
  };
  const current = () => client.getQueryData<string[]>(queryKey) ?? list;

  return {
    list,
    add: (term: string) => save(withRecent(current(), term)),
    remove: (term: string) => save(withoutRecent(current(), term)),
    clear: () => save([]),
  };
}
