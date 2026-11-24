import { queryOptions } from "@tanstack/react-query";

import type { LibraryItem, Progress } from "@bindings/store";
import { Service as Store } from "@bindings/store";
import type { TitlePreview } from "@/lib/title";

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

// When the profile last watched each title, by content ID, for the library's
// "Recently watched" sort (#46). A pull of progress or watched refreshes it
// (lib/sync.ts).
export const lastWatchedQuery = (profileId: number) =>
  queryOptions({
    queryKey: ["last-watched", profileId],
    queryFn: async () => (await Store.LastWatched(profileId)) ?? {},
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

// "S2 · E5" by content ID for the entries that are on an episode, so the
// library's cards can show where a show in progress is up to (#118).
export function episodeLabels(entries: readonly Progress[]): Map<string, string> {
  const labels = new Map<string, string>();
  for (const entry of entries) {
    const label = episodeLabel(entry);
    if (label) labels.set(entry.contentId, label);
  }
  return labels;
}

// How far into each title in progress the profile is, 0 to 1, by content
// ID, for the dense grid's progress bar (#132). Entries with nothing watched
// yet (a next episode at 0) are left out, so their cards show no bar.
export function progressFractions(entries: readonly Progress[]): Map<string, number> {
  const fractions = new Map<string, number>();
  for (const entry of entries) {
    const fraction = watchedFraction(entry);
    if (fraction > 0 && !fractions.has(entry.contentId)) fractions.set(entry.contentId, fraction);
  }
  return fractions;
}

// The dense card's one meta line (#132): where a show in progress is up to,
// else the year.
export const denseLibraryMeta = (item: LibraryItem, episode?: string): string | undefined =>
  episode || item.releaseInfo || undefined;

// A library card's meta line: the year, then "S2 · E5" for a show in progress.
export const libraryMeta = (item: LibraryItem, episode?: string): string | undefined =>
  [item.releaseInfo, episode].filter(Boolean).join(" · ") || undefined;

// What is left of an entry, for under its title: "38 min left", "1 h 12 min
// left". Positions are milliseconds. Nothing without a known duration.
export function timeLeft(entry: Progress): string | undefined {
  if (entry.duration <= 0) return undefined;
  const minutes = Math.max(1, Math.ceil((entry.duration - entry.position) / 60_000));
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours === 0) return `${minutes} min left`;
  return rest === 0 ? `${hours} h left` : `${hours} h ${rest} min left`;
}

// How much of an entry has been watched, 0 to 1.
export function watchedFraction(entry: Progress): number {
  return entry.duration > 0 ? entry.position / entry.duration : 0;
}

// What opening a library title passes the title page, so its hero paints at
// once (#45).
export const libraryPreview = (item: LibraryItem): TitlePreview => ({
  id: item.contentId,
  type: item.contentType,
  name: item.name,
  poster: item.poster,
  background: item.background,
  releaseInfo: item.releaseInfo,
  description: item.description,
});

// The Library page's choices (#46), kept in the address so Back from a title
// returns to them. No type means all of them; no view means the titles, not
// the Upcoming calendar (#48), the Watchlist or the downloads (#85); no layout
// means Upcoming's list rather than its month grid.
export type LibrarySort = "added" | "watched" | "name";
export type LibraryView = "upcoming" | "watchlist" | "downloads";
export type UpcomingLayout = "calendar";
export type LibrarySearch = {
  type?: string;
  sort?: LibrarySort;
  view?: LibraryView | undefined;
  layout?: UpcomingLayout | undefined;
};

export const librarySorts: readonly { value: LibrarySort; label: string }[] = [
  { value: "added", label: "Recently added" },
  { value: "watched", label: "Recently watched" },
  { value: "name", label: "A–Z" },
];

// The caption under the iPhone's chips (#132): only when the sort isn't the
// default.
export function sortCaption(sort: LibrarySort): string | undefined {
  if (sort === "added") return undefined;
  const label = librarySorts.find((option) => option.value === sort)?.label;
  return label ? `Sorted by ${label}` : undefined;
}

export function librarySearch(search: Record<string, unknown>): LibrarySearch {
  const { type } = search;
  const view = search["view"];
  const layout = search["layout"];
  const sort = librarySorts.find((option) => option.value === search["sort"])?.value;
  return {
    ...(typeof type === "string" && type ? { type } : {}),
    ...(sort ? { sort } : {}),
    ...(view === "upcoming" || view === "watchlist" || view === "downloads" ? { view } : {}),
    ...(layout === "calendar" ? { layout } : {}),
  };
}

const typeLabels: Record<string, string> = { movie: "Movies", series: "Shows", anime: "Anime" };

// The library's content types, in the order Movies, Shows, Anime, then any
// other an addon uses ("tv", "channel"), by name.
export function libraryTypes(items: readonly LibraryItem[]): { type: string; label: string }[] {
  const known = Object.keys(typeLabels);
  const rank = (type: string) => (known.includes(type) ? known.indexOf(type) : known.length);
  return [...new Set(items.map((item) => item.contentType))]
    .toSorted((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((type) => ({
      type,
      label: typeLabels[type] ?? type.charAt(0).toUpperCase() + type.slice(1),
    }));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

// The library filtered to one type and sorted. Recently watched puts titles
// never watched last, most recently added first, as the store gives them.
export function libraryItems(
  items: readonly LibraryItem[],
  { type, sort = "added" }: { type?: string | undefined; sort?: LibrarySort | undefined },
  lastWatched: Readonly<Record<string, number | undefined>> = {},
): LibraryItem[] {
  const shown = type ? items.filter((item) => item.contentType === type) : items;
  const order: Record<LibrarySort, (a: LibraryItem, b: LibraryItem) => number> = {
    added: (a, b) => b.addedAt - a.addedAt,
    watched: (a, b) =>
      (lastWatched[b.contentId] ?? 0) - (lastWatched[a.contentId] ?? 0) || b.addedAt - a.addedAt,
    name: (a, b) => collator.compare(a.name, b.name),
  };
  return shown.toSorted(order[sort]);
}
