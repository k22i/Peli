import { queryOptions } from "@tanstack/react-query";

import type { LibraryItem, Progress } from "@bindings/store";
import { Service as Store } from "@bindings/store";

// The profile's library and Continue Watching, read from the local store
// (#14), so they show with no network (#31). Their keys sit under the
// surfaces' prefixes in lib/sync.ts, so a pull refreshes them, and under the
// profile's ID, so a profile switch loads the new one's (#24). Not persisted:
// the store is already on disk, and reading it takes milliseconds.
export const libraryQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["library", profileId],
    queryFn: () => Store.Library(profileId),
  });

export const continueWatchingQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["continue-watching", profileId],
    queryFn: () => Store.ContinueWatching(profileId),
  });

// What Continue Watching can show for an entry before there is addon
// metadata (#42): the title's name and art if it's in the library.
export type ContinueWatchingItem = {
  entry: Progress;
  title: string;
  art?: string | undefined;
};

export function continueWatchingItems(
  entries: readonly Progress[],
  library: readonly LibraryItem[],
): ContinueWatchingItem[] {
  const byId = new Map(library.map((item) => [item.contentId, item]));
  return entries.map((entry) => {
    const item = byId.get(entry.contentId);
    return { entry, title: item?.name || entry.contentId, art: item?.background || item?.poster };
  });
}

// "S1 · E2" for an episode, nothing for a film.
export function episodeLabel(entry: Progress): string | undefined {
  if (entry.season == null || entry.episode == null) return undefined;
  return `S${entry.season} · E${entry.episode}`;
}

// How much of an entry has been watched, 0 to 1.
export function watchedFraction(entry: Progress): number {
  return entry.duration > 0 ? entry.position / entry.duration : 0;
}
