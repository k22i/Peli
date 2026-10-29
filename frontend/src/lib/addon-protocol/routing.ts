import type { Catalog, ContentType, ExtraName, Manifest, ResourceName } from "./types";

// Which addons answer which request, by the rules Stremio's apps use. Every
// function keeps the order it's given, which is the user's addon order: it
// decides catalog rows (#42) and whose streams come first (#50).

// An installed addon whose manifest loaded. Callers pass only enabled
// addons, and for browsing and search only the ones a kids profile may see
// (Store.VisibleAddons); streams and subtitles aren't limited.
export type LoadedAddon = { url: string; manifest: Manifest };

// Whether an addon answers `resource` for `type` and, when given, `id`. A
// resource without id prefixes answers any id. An addon that must be
// configured first answers nothing.
export function serves(
  manifest: Manifest,
  resource: ResourceName,
  type: ContentType,
  id?: string,
): boolean {
  if (manifest.behaviorHints.configurationRequired) return false;
  return manifest.resources.some(
    (r) =>
      r.name === resource &&
      r.types.includes(type) &&
      (id === undefined ||
        r.idPrefixes === undefined ||
        r.idPrefixes.length === 0 ||
        r.idPrefixes.some((prefix) => id.startsWith(prefix))),
  );
}

// The addons to ask for `resource` of the title or video `id`, in order:
// every stream addon for the stream picker (#50), the first meta addon that
// answers for a title page (#45), subtitle addons for the player (#63).
export function addonsFor<A extends LoadedAddon>(
  addons: readonly A[],
  resource: "meta" | "stream" | "subtitles",
  type: ContentType,
  id: string,
): A[] {
  return addons.filter((addon) => serves(addon.manifest, resource, type, id));
}

export type CatalogSource<A extends LoadedAddon = LoadedAddon> = { addon: A; catalog: Catalog };

// The catalogs that can be asked with exactly these extras: every extra the
// catalog requires is given, and it takes every one given. No extras gives
// the catalogs Home and browse can show as they are; ["search"] gives
// search's (#44); ["genre"] the ones a genre filter can narrow (#43).
export function catalogsAccepting<A extends LoadedAddon>(
  addons: readonly A[],
  extras: readonly ExtraName[],
  type?: ContentType,
): CatalogSource<A>[] {
  return addons.flatMap((addon) => {
    if (addon.manifest.behaviorHints.configurationRequired) return [];
    return addon.manifest.catalogs
      .filter(
        (catalog) =>
          (type === undefined || catalog.type === type) &&
          catalog.extra.every((extra) => !extra.isRequired || extras.includes(extra.name)) &&
          extras.every((name) => catalog.extra.some((extra) => extra.name === name)),
      )
      .map((catalog) => ({ addon, catalog }));
  });
}

// A catalog's choices for an extra, such as its genres; Cinemeta's "New"
// catalogs list years as genres.
export function extraOptions(catalog: Catalog, name: ExtraName): string[] {
  return catalog.extra.find((extra) => extra.name === name)?.options ?? [];
}

// The catalog named by Home's layout (#35), which names addons by manifest
// id.
export function findCatalog<A extends LoadedAddon>(
  addons: readonly A[],
  addonId: string,
  type: ContentType,
  catalogId: string,
): CatalogSource<A> | undefined {
  for (const addon of addons) {
    if (addon.manifest.id !== addonId) continue;
    const catalog = addon.manifest.catalogs.find((c) => c.type === type && c.id === catalogId);
    if (catalog) return { addon, catalog };
  }
  return undefined;
}
