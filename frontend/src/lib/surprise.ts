import { queryOptions } from "@tanstack/react-query";

import type { LibraryItem, WatchedItem } from "@bindings/store";
import { Service as Store } from "@bindings/store";
import type { MetaPreview } from "@/lib/addon-protocol";

// "Surprise me" on Home: a random title you haven't watched. It picks from
// the library first and, when everything in it has been watched (or it is
// empty), from the first catalog on Home.

// Everything the profile has marked watched. Under the "watched" prefix, so a
// mark or a pull refreshes it (lib/sync.ts).
export const allWatchedQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["watched", profileId, "all"],
    queryFn: async () => (await Store.Watched(profileId)) ?? [],
  });

// A title counts as watched once anything of it is marked: the title itself, or
// an episode (a show you've started isn't a surprise).
export const watchedIds = (marks: readonly WatchedItem[]) =>
  new Set(marks.map((mark) => mark.contentId));

// One of `items` that isn't watched, chosen by `random` (0 up to 1), or
// undefined when there is none.
export function pickUnwatched<T>(
  items: readonly T[],
  idOf: (item: T) => string,
  watched: ReadonlySet<string>,
  random: () => number = Math.random,
): T | undefined {
  const fresh = items.filter((item) => !watched.has(idOf(item)));
  return fresh[Math.min(Math.floor(random() * fresh.length), fresh.length - 1)];
}

export type Surprise =
  | { from: "library"; item: LibraryItem }
  | { from: "catalog"; meta: MetaPreview };

export function surprise(
  library: readonly LibraryItem[],
  catalog: readonly MetaPreview[],
  watched: ReadonlySet<string>,
  random: () => number = Math.random,
): Surprise | undefined {
  const item = pickUnwatched(library, (entry) => entry.contentId, watched, random);
  if (item) return { from: "library", item };
  const meta = pickUnwatched(catalog, (entry) => entry.id, watched, random);
  return meta && { from: "catalog", meta };
}
