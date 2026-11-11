import {
  catalogsAccepting,
  type CatalogSource,
  type LoadedAddon,
  type MetaPreview,
} from "@/lib/addon-protocol";
import { isAnimeCatalog } from "@/lib/browse";
import { typeName } from "@/lib/home";

// Search (#44): every catalog that takes `search`, asked at once, with the
// results merged as each addon answers (ADR-0028).

// The search field, for the shortcut that focuses it from anywhere.
export const searchFieldId = "search-field";

// How long typing must pause before a search goes out, and the shortest
// query worth sending.
export const searchDebounceMs = 300;
export const minQueryLength = 2;

// What Search keeps in its address, so Back from a title page (#45) shows
// the same results.
export type SearchSearch = {
  q?: string;
  // Narrow the results to one kind, to a decade, or to a genre. All are
  // kept in the address with the query.
  type?: SearchKind;
  year?: SearchYear;
  genre?: string;
};

// A change to the filters: a key set to undefined drops it from the address.
export type SearchChange = { [K in keyof SearchSearch]?: SearchSearch[K] | undefined };

// The address's search with `changes` applied; a key set to undefined goes.
export function changeSearch(search: SearchSearch, changes: SearchChange): SearchSearch {
  return searchSearch({ ...search, ...changes });
}

export const searchKinds = ["movie", "series", "anime"] as const;
export type SearchKind = (typeof searchKinds)[number];
// A decade by its first year, or everything before 1990.
export const searchYears = ["2020", "2010", "2000", "1990", "older"] as const;
export type SearchYear = (typeof searchYears)[number];

export function searchSearch(search: Record<string, unknown>): SearchSearch {
  // The router reads a bare number in the address ("1917") as a number.
  const number = (value: unknown) => (typeof value === "number" ? String(value) : value);
  const q = number(search["q"]);
  const type = searchKinds.find((kind) => kind === search["type"]);
  const year = searchYears.find((decade) => decade === number(search["year"]));
  const genre = search["genre"];
  return {
    ...(typeof q === "string" && q.trim() && { q }),
    ...(type && { type }),
    ...(year && { year }),
    ...(typeof genre === "string" && genre.trim() && { genre }),
  };
}

// A title's first year, from "2010", "2010–2013" or "2010-".
const yearOf = (meta: MetaPreview) => {
  const year = /\d{4}/.exec(meta.releaseInfo ?? meta.released ?? "")?.[0];
  return year ? Number(year) : undefined;
};

const inDecade = (year: number, decade: SearchYear) =>
  decade === "older" ? year < 1990 : year >= Number(decade) && year < Number(decade) + 10;

// The groups narrowed by the filters; a group left empty goes. A title with
// no year can't be placed in a decade, so a year filter leaves it out.
export function filterGroups(
  groups: readonly SearchGroup[],
  { type, year, genre }: Pick<SearchSearch, "type" | "year" | "genre">,
): SearchGroup[] {
  const wanted = genre?.toLowerCase();
  return groups
    .filter((group) => !type || group.kind === type)
    .flatMap((group) => {
      const metas = group.metas.filter((meta) => {
        if (year) {
          const released = yearOf(meta);
          if (released === undefined || !inDecade(released, year)) return false;
        }
        return !wanted || (meta.genres ?? []).some((g) => g.toLowerCase() === wanted);
      });
      return metas.length > 0 ? [{ ...group, metas }] : [];
    });
}

// The genres the results carry, most common first, for the genre filter.
export function searchGenres(groups: readonly SearchGroup[]): string[] {
  // "Drama" and "drama" are one genre; the first spelling seen is kept.
  const counts = new Map<string, { name: string; count: number }>();
  for (const { metas } of groups) {
    for (const meta of metas) {
      for (const genre of meta.genres ?? []) {
        const entry = counts.get(genre.toLowerCase()) ?? { name: genre, count: 0 };
        counts.set(genre.toLowerCase(), { ...entry, count: entry.count + 1 });
      }
    }
  }
  return [...counts.values()]
    .toSorted((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .map(({ name }) => name)
    .slice(0, 24);
}

// The query as it's sent, or undefined while it's too short to send.
export function searchTerm(text: string | undefined): string | undefined {
  const term = text?.trim().replace(/\s+/g, " ");
  return term && term.length >= minQueryLength ? term : undefined;
}

// The catalogs a search asks, in addon order: those that take `search` and
// need nothing else, as catalogsAccepting picks them. `visible` is
// CatalogVisible, so a kids profile never asks the catalogs its parent
// didn't allow.
export function searchCatalogs<A extends LoadedAddon>(
  addons: readonly A[],
  visible: (source: CatalogSource<A>) => boolean = () => true,
): CatalogSource<A>[] {
  return catalogsAccepting(addons, ["search"]).filter(visible);
}

// One search catalog's answer so far: its results once it has answered.
export type SearchAnswer = { source: CatalogSource; metas?: readonly MetaPreview[] | undefined };

// Results of one kind, under its heading, and the names of the addons that
// gave them (#119: "Movies · Cinemeta"), in addon order.
export type SearchGroup = { kind: string; title: string; addons: string[]; metas: MetaPreview[] };

const groupOrder = ["movie", "series", "anime"];
const rank = (kind: string) => {
  const index = groupOrder.indexOf(kind);
  return index === -1 ? groupOrder.length : index;
};

// The answers so far, in the order the catalogs were asked (the user's addon
// order), as groups: Movies, Shows and Anime, then any other type in the
// order it first appears. A title two catalogs both found shows once, where
// the first one put it. Anime catalogs' results go under Anime whatever
// their items' types, as the browse pages split them (ADR-0027).
//
// `leaveOutAnime` drops general catalogs' anime (#109): the anime catalogs'
// own results have it under Anime.
export function searchGroups(
  answers: readonly SearchAnswer[],
  leaveOutAnime: (id: string) => boolean = () => false,
): SearchGroup[] {
  const seen = new Set<string>();
  const groups = new Map<string, { metas: MetaPreview[]; addons: Set<string> }>();
  for (const { source, metas } of answers) {
    const anime = isAnimeCatalog(source);
    for (const meta of metas ?? []) {
      if (seen.has(meta.id) || (!anime && leaveOutAnime(meta.id))) continue;
      seen.add(meta.id);
      const kind = anime ? "anime" : meta.type;
      const group = groups.get(kind) ?? { metas: [], addons: new Set<string>() };
      groups.set(kind, group);
      group.metas.push(meta);
      group.addons.add(source.addon.manifest.name);
    }
  }
  return [...groups]
    .toSorted(([a], [b]) => rank(a) - rank(b))
    .map(([kind, { metas, addons }]) => ({
      kind,
      title: typeName(kind),
      addons: [...addons],
      metas,
    }));
}

// The addons behind a group, for its heading: "Cinemeta", "Cinemeta and
// Kitsu", "Cinemeta +2" (the first one, then how many more).
export function groupByline(addons: readonly string[]): string {
  if (addons.length <= 2) return new Intl.ListFormat("en", { type: "conjunction" }).format(addons);
  return `${addons[0]} +${addons.length - 1}`;
}
