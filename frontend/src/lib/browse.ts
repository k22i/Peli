import type { Catalog, CatalogSource, LoadedAddon } from "@/lib/addon-protocol";
import { catalogRef, typeName } from "@/lib/home";

// A browse page (#43): Movies, Shows or Anime.
export type BrowseKind = "movie" | "series" | "anime";

// What a browse page keeps in its address, so Back from a title page (#45)
// comes back to the same view: the catalog, as catalogRef names it, and its
// genre or year.
export type BrowseSearch = { catalog?: string; genre?: string };

export function browseSearch(search: Record<string, unknown>): BrowseSearch {
  const { catalog } = search;
  // The router reads a bare year in the address as a number.
  const genre = typeof search["genre"] === "number" ? String(search["genre"]) : search["genre"];
  return {
    ...(typeof catalog === "string" && catalog ? { catalog } : {}),
    ...(typeof genre === "string" && genre ? { genre } : {}),
  };
}

// Anime addons answer only anime databases' ids. Kitsu's are "kitsu", "mal",
// "anilist" and "anidb", and others write them with a separator ("mal:").
const animeIdPrefixes = new Set(["kitsu", "mal", "anilist", "anidb"]);

// Whether a catalog belongs on the Anime page rather than Movies or Shows
// (ADR-0027): it's typed "anime", or its addon's catalogs list only anime
// ids, as an anime addon's "series" and "movie" catalogs do. By type and
// addon only: Cinemeta's Animation genre stays a genre of Movies and Shows.
export function isAnimeCatalog({ addon, catalog }: CatalogSource): boolean {
  if (catalog.type === "anime") return true;
  const prefixes = addon.manifest.resources.find(
    (resource) => resource.name === "catalog" && resource.types.includes(catalog.type),
  )?.idPrefixes;
  return (
    prefixes !== undefined &&
    prefixes.length > 0 &&
    prefixes.every((prefix) => animeIdPrefixes.has(prefix.toLowerCase().replace(/[:_-]$/, "")))
  );
}

// The filter a catalog offers: its `genre` extra, called Year when every
// option is a year, as on Cinemeta's "New" catalogs. A required one always
// has a value; the others start at all.
export type BrowseFilter = { label: "Genre" | "Year"; options: string[]; required: boolean };

export function catalogFilter(catalog: Catalog): BrowseFilter | undefined {
  const genre = catalog.extra.find((extra) => extra.name === "genre");
  const options = genre?.options ?? [];
  if (!genre || options.length === 0) return undefined;
  return {
    label: options.every((option) => /^\d{4}$/.test(option)) ? "Year" : "Genre",
    options,
    required: genre.isRequired,
  };
}

// Whether a catalog can page with `skip`.
export const canPage = (catalog: Catalog) => catalog.extra.some((extra) => extra.name === "skip");

// A catalog on a browse page, with its chip's label.
export type BrowseCatalog<A extends LoadedAddon = LoadedAddon> = CatalogSource<A> & {
  ref: string;
  label: string;
};

// The catalogs a browse page offers, in addon order: those of its type (any
// type, for Anime) that can be asked with nothing but a genre. Search,
// calendar and "last videos" catalogs need extras browse can't give.
// `visible` is CatalogVisible, so a kids profile sees only what its parent
// allowed.
export function browseCatalogs<A extends LoadedAddon>(
  addons: readonly A[],
  kind: BrowseKind,
  visible: (source: CatalogSource<A>) => boolean = () => true,
): BrowseCatalog<A>[] {
  const sources = addons.flatMap((addon) => {
    if (addon.manifest.behaviorHints.configurationRequired) return [];
    return addon.manifest.catalogs
      .map((catalog) => ({ addon, catalog }))
      .filter(
        (source) =>
          (kind === "anime"
            ? isAnimeCatalog(source)
            : source.catalog.type === kind && !isAnimeCatalog(source)) &&
          source.catalog.extra.every(
            (extra) =>
              !extra.isRequired || (extra.name === "genre" && (extra.options?.length ?? 0) > 0),
          ) &&
          visible(source),
      );
  });
  const labels = chipLabels(sources, kind);
  return sources.map(({ addon, catalog }, i) => ({
    addon,
    catalog,
    ref: catalogRef({ addon, catalog }),
    label: labels[i]!,
  }));
}

// Chip labels: the catalog's name, with its type on the Anime page when it
// isn't "anime" ("Popular · Shows"), and its addon's name when two still
// read the same.
function chipLabels(sources: readonly CatalogSource[], kind: BrowseKind): string[] {
  const names = sources.map(({ addon, catalog }) => {
    const name = catalog.name || addon.manifest.name;
    return kind === "anime" && catalog.type !== "anime"
      ? `${name} · ${typeName(catalog.type)}`
      : name;
  });
  return names.map((name, i) =>
    names.indexOf(name) === names.lastIndexOf(name)
      ? name
      : `${name} · ${sources[i]!.addon.manifest.name}`,
  );
}

// The page's title.
export const browseTitle = (kind: BrowseKind) => typeName(kind);
