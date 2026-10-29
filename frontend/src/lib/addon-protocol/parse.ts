import type {
  CacheHints,
  Catalog,
  CatalogExtra,
  CatalogResponse,
  Manifest,
  ManifestBehaviorHints,
  Meta,
  MetaLink,
  MetaPreview,
  MetaResponse,
  Resource,
  Stream,
  StreamBehaviorHints,
  StreamResponse,
  Subtitle,
  SubtitlesResponse,
  Video,
} from "./types";

// Reading addon answers. Addons are written by many people and checked by
// none, so this is lenient: a field of the wrong type is dropped (or a
// number read from a numeric string), a list item that isn't usable is
// skipped, and fields nobody names are kept. Only an answer without the one
// thing a resource is for (a manifest's id, name and version; a catalog's
// metas; a meta; streams; subtitles) is refused, with InvalidAnswer.

export class InvalidAnswer extends Error {}

type Fields = Record<string, unknown>;

const isFields = (value: unknown): value is Fields =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function str(value: unknown): string | undefined {
  if (typeof value === "string") return value;
  return typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
}

function num(value: unknown): number | undefined {
  if (typeof value === "number") return Number.isFinite(value) ? value : undefined;
  if (typeof value !== "string" || value.trim() === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

const bool = (value: unknown) => (typeof value === "boolean" ? value : undefined);

// A list of strings; a lone string counts as a list of one.
function strs(value: unknown): string[] | undefined {
  if (typeof value === "string") return [value];
  if (!Array.isArray(value)) return undefined;
  return value.filter((item) => typeof item === "string");
}

function list<T>(value: unknown, parse: (fields: Fields) => T | undefined): T[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.flatMap((item) => {
    const parsed = isFields(item) ? parse(item) : undefined;
    return parsed === undefined ? [] : [parsed];
  });
}

// { [key]: value }, or nothing when value is undefined: an optional field
// under exactOptionalPropertyTypes.
function field<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  const out: Partial<Record<K, V>> = {};
  if (value !== undefined) out[key] = value;
  return out;
}

function cacheHints(answer: Fields): CacheHints {
  return {
    ...field("cacheMaxAge", num(answer["cacheMaxAge"])),
    ...field("staleRevalidate", num(answer["staleRevalidate"])),
    ...field("staleError", num(answer["staleError"])),
  };
}

// --- Manifest ---------------------------------------------------------------

export function parseManifest(answer: unknown): Manifest {
  if (!isFields(answer)) throw new InvalidAnswer("not a manifest");
  const {
    id,
    name,
    version,
    description,
    logo,
    background,
    contactEmail,
    types,
    idPrefixes,
    resources,
    catalogs,
    behaviorHints,
    ...rest
  } = answer;
  const manifestId = str(id);
  const manifestName = str(name);
  const manifestVersion = str(version);
  if (manifestId === undefined || manifestName === undefined || manifestVersion === undefined) {
    throw new InvalidAnswer("not a manifest");
  }
  const allTypes = strs(types) ?? [];
  const allPrefixes = strs(idPrefixes);
  return {
    ...rest,
    id: manifestId,
    name: manifestName,
    version: manifestVersion,
    ...field("description", str(description)),
    ...field("logo", str(logo)),
    ...field("background", str(background)),
    ...field("contactEmail", str(contactEmail)),
    types: allTypes,
    ...field("idPrefixes", allPrefixes),
    resources: parseResources(resources, allTypes, allPrefixes),
    catalogs: list(catalogs, parseCatalog) ?? [],
    behaviorHints: isFields(behaviorHints) ? parseManifestHints(behaviorHints) : {},
  };
}

// A resource is a name ("stream"), answering for the manifest's types and id
// prefixes, or an object with its own.
function parseResources(
  value: unknown,
  types: string[],
  idPrefixes: string[] | undefined,
): Resource[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item): Resource[] => {
    if (typeof item === "string") {
      return [{ name: item, types, ...field("idPrefixes", idPrefixes) }];
    }
    if (!isFields(item)) return [];
    const name = str(item["name"]);
    if (name === undefined) return [];
    return [
      {
        name,
        types: strs(item["types"]) ?? types,
        ...field("idPrefixes", strs(item["idPrefixes"]) ?? idPrefixes),
      },
    ];
  });
}

function parseCatalog(catalog: Fields): Catalog | undefined {
  const { type, id, name, extra, extraSupported, extraRequired, ...rest } = catalog;
  const catalogType = str(type);
  const catalogId = str(id);
  if (catalogType === undefined || catalogId === undefined) return undefined;
  return {
    ...rest,
    type: catalogType,
    id: catalogId,
    ...field("name", str(name)),
    extra: Array.isArray(extra)
      ? (list(extra, parseExtra) ?? [])
      : legacyExtra(strs(extraSupported) ?? [], strs(extraRequired) ?? [], strs(rest["genres"])),
  };
}

function parseExtra(extra: Fields): CatalogExtra | undefined {
  const { name, isRequired, options, optionsLimit, ...rest } = extra;
  const extraName = str(name);
  if (extraName === undefined) return undefined;
  return {
    ...rest,
    name: extraName,
    isRequired: bool(isRequired) ?? false,
    ...field("options", strs(options)),
    ...field("optionsLimit", num(optionsLimit)),
  };
}

// Before `extra`, catalogs listed the extras they take in `extraSupported`,
// those they need in `extraRequired`, and genre options in `genres`.
function legacyExtra(
  supported: string[],
  required: string[],
  genres: string[] | undefined,
): CatalogExtra[] {
  const names = new Set([...supported, ...required]);
  if (genres) names.add("genre");
  return [...names].map((name): CatalogExtra => {
    const extra: CatalogExtra = { name, isRequired: required.includes(name) };
    if (name === "genre" && genres) extra.options = genres;
    return extra;
  });
}

function parseManifestHints(hints: Fields): ManifestBehaviorHints {
  const { adult, p2p, configurable, configurationRequired, ...rest } = hints;
  return {
    ...rest,
    ...field("adult", bool(adult)),
    ...field("p2p", bool(p2p)),
    ...field("configurable", bool(configurable)),
    ...field("configurationRequired", bool(configurationRequired)),
  };
}

// --- Catalog and meta -------------------------------------------------------

export function parseCatalogResponse(answer: unknown): CatalogResponse {
  if (!isFields(answer) || !Array.isArray(answer["metas"])) {
    throw new InvalidAnswer("not a catalog");
  }
  return {
    metas: list(answer["metas"], parseMetaPreview) ?? [],
    ...field("hasMore", bool(answer["hasMore"])),
    ...cacheHints(answer),
  };
}

export function parseMetaResponse(answer: unknown): MetaResponse {
  const meta = isFields(answer) && isFields(answer["meta"]) ? parseMeta(answer["meta"]) : undefined;
  if (!isFields(answer) || meta === undefined) throw new InvalidAnswer("not a meta");
  return { meta, ...cacheHints(answer) };
}

function parseMetaPreview(meta: Fields): MetaPreview | undefined {
  const {
    id,
    type,
    name,
    poster,
    posterShape,
    background,
    logo,
    description,
    releaseInfo,
    imdbRating,
    genres,
    links,
    trailerStreams,
    ...rest
  } = meta;
  const metaId = str(id);
  const metaType = str(type);
  if (metaId === undefined || metaType === undefined) return undefined;
  return {
    ...rest,
    id: metaId,
    type: metaType,
    name: str(name) ?? "",
    ...field("poster", str(poster)),
    ...field("posterShape", str(posterShape)),
    ...field("background", str(background)),
    ...field("logo", str(logo)),
    ...field("description", str(description)),
    ...field("releaseInfo", str(releaseInfo)),
    ...field("imdbRating", str(imdbRating)),
    ...field("genres", strs(genres)),
    ...field("links", list(links, parseLink)),
    ...field("trailerStreams", list(trailerStreams, parseStream)),
  };
}

function parseMeta(meta: Fields): Meta | undefined {
  const preview = parseMetaPreview(meta);
  if (preview === undefined) return undefined;
  const {
    videos,
    runtime,
    released,
    language,
    country,
    awards,
    website,
    director,
    cast,
    writer,
    behaviorHints,
  } = meta;
  return {
    ...preview,
    ...field("videos", list(videos, parseVideo)),
    ...field("runtime", str(runtime)),
    ...field("released", str(released)),
    ...field("language", str(language)),
    ...field("country", str(country)),
    ...field("awards", str(awards)),
    ...field("website", str(website)),
    ...field("director", strs(director)),
    ...field("cast", strs(cast)),
    ...field("writer", strs(writer)),
    ...(isFields(behaviorHints) && {
      behaviorHints: {
        ...behaviorHints,
        ...field("defaultVideoId", str(behaviorHints["defaultVideoId"])),
        ...field("hasScheduledVideos", bool(behaviorHints["hasScheduledVideos"])),
      },
    }),
  };
}

function parseLink(link: Fields): MetaLink | undefined {
  const name = str(link["name"]);
  const category = str(link["category"]);
  const url = str(link["url"]);
  if (name === undefined || category === undefined || url === undefined) return undefined;
  return { ...link, name, category, url };
}

// Cinemeta names an episode `name` and its synopsis `description` as well as
// `overview`; Kitsu uses `title`.
function parseVideo(video: Fields): Video | undefined {
  const {
    id,
    title,
    released,
    thumbnail,
    season,
    episode,
    overview,
    available,
    streams,
    trailers,
  } = video;
  const videoId = str(id);
  if (videoId === undefined) return undefined;
  return {
    ...video,
    id: videoId,
    title: str(title) ?? str(video["name"]) ?? "",
    ...field("released", str(released)),
    ...field("thumbnail", str(thumbnail)),
    ...field("season", num(season)),
    ...field("episode", num(episode)),
    ...field("overview", str(overview) ?? str(video["description"])),
    ...field("available", bool(available)),
    ...field("streams", list(streams, parseStream)),
    ...field("trailers", list(trailers, parseStream)),
  };
}

// --- Streams and subtitles --------------------------------------------------

export function parseStreamResponse(answer: unknown): StreamResponse {
  if (!isFields(answer) || !Array.isArray(answer["streams"])) {
    throw new InvalidAnswer("not a stream list");
  }
  return { streams: list(answer["streams"], parseStream) ?? [], ...cacheHints(answer) };
}

export function parseSubtitlesResponse(answer: unknown): SubtitlesResponse {
  if (!isFields(answer) || !Array.isArray(answer["subtitles"])) {
    throw new InvalidAnswer("not a subtitle list");
  }
  return { subtitles: list(answer["subtitles"], parseSubtitle) ?? [], ...cacheHints(answer) };
}

// Torrentio and TorrentsDB put the text in the deprecated `title` only; it
// is copied to `description` so nothing downstream reads both.
function parseStream(stream: Fields): Stream {
  const {
    name,
    description,
    title,
    url,
    ytId,
    infoHash,
    fileIdx,
    externalUrl,
    sources,
    subtitles,
    behaviorHints,
    ...rest
  } = stream;
  return {
    ...rest,
    ...field("name", str(name)),
    ...field("description", str(description) ?? str(title)),
    ...field("title", str(title)),
    ...field("url", str(url)),
    ...field("ytId", str(ytId)),
    ...field("infoHash", str(infoHash)),
    ...field("fileIdx", num(fileIdx)),
    ...field("externalUrl", str(externalUrl)),
    ...field("sources", strs(sources)),
    ...field("subtitles", list(subtitles, parseSubtitle)),
    ...(isFields(behaviorHints) && { behaviorHints: parseStreamHints(behaviorHints) }),
  };
}

function parseStreamHints(hints: Fields): StreamBehaviorHints {
  const {
    bingeGroup,
    filename,
    videoSize,
    videoHash,
    notWebReady,
    countryWhitelist,
    proxyHeaders,
    ...rest
  } = hints;
  return {
    ...rest,
    ...field("bingeGroup", str(bingeGroup)),
    ...field("filename", str(filename)),
    ...field("videoSize", num(videoSize)),
    ...field("videoHash", str(videoHash)),
    ...field("notWebReady", bool(notWebReady)),
    ...field("countryWhitelist", strs(countryWhitelist)),
    ...(isFields(proxyHeaders) && {
      proxyHeaders: {
        ...field("request", headers(proxyHeaders["request"])),
        ...field("response", headers(proxyHeaders["response"])),
      },
    }),
  };
}

function headers(value: unknown): Record<string, string> | undefined {
  if (!isFields(value)) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
}

function parseSubtitle(subtitle: Fields): Subtitle | undefined {
  const url = str(subtitle["url"]);
  const lang = str(subtitle["lang"]);
  if (url === undefined || lang === undefined) return undefined;
  return { ...subtitle, id: str(subtitle["id"]) ?? url, url, lang };
}
