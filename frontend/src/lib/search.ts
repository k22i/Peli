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
export type SearchSearch = { q?: string };

export function searchSearch(search: Record<string, unknown>): SearchSearch {
  // The router reads a bare number in the address ("1917") as a number.
  const q = typeof search["q"] === "number" ? String(search["q"]) : search["q"];
  return typeof q === "string" && q.trim() ? { q } : {};
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

// Results of one kind, under its heading.
export type SearchGroup = { kind: string; title: string; metas: MetaPreview[] };

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
  const groups = new Map<string, MetaPreview[]>();
  for (const { source, metas } of answers) {
    const anime = isAnimeCatalog(source);
    for (const meta of metas ?? []) {
      if (seen.has(meta.id) || (!anime && leaveOutAnime(meta.id))) continue;
      seen.add(meta.id);
      const kind = anime ? "anime" : meta.type;
      const group = groups.get(kind);
      if (group) group.push(meta);
      else groups.set(kind, [meta]);
    }
  }
  return [...groups]
    .toSorted(([a], [b]) => rank(a) - rank(b))
    .map(([kind, metas]) => ({ kind, title: typeName(kind), metas }));
}
