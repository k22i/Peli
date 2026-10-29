// The Stremio addon protocol, as addons actually send it (#37). Every type
// keeps fields it doesn't name (`[field: string]: unknown`): addons add their
// own, such as Peerflix's top-level `seed` and `sizebytes` on a stream, and
// the ranking engine (#51) reads them. Named fields are checked by parse.ts,
// so a field typed string is a string or absent.

// Open unions: addons use their own types ("anime", "tv", "events") and
// resources.
export type ContentType = "movie" | "series" | "channel" | "tv" | "anime" | "other" | (string & {});
export type ResourceName =
  | "catalog"
  | "meta"
  | "stream"
  | "subtitles"
  | "addon_catalog"
  | (string & {});
export type ExtraName = "search" | "genre" | "skip" | (string & {});

// A resource and what it answers for. parse.ts fills `types` and
// `idPrefixes` from the manifest's when a resource doesn't give its own, as
// the short form ("stream") does.
export type Resource = {
  name: ResourceName;
  types: ContentType[];
  // Absent: any id.
  idPrefixes?: string[];
};

// An extra property a catalog takes, such as `genre` with its options. Cinemeta
// lists years as `genre` options on its "year" catalog.
export type CatalogExtra = {
  name: ExtraName;
  isRequired: boolean;
  options?: string[];
  // How many values may be sent at once; 1 if absent.
  optionsLimit?: number;
  [field: string]: unknown;
};

// A catalog an addon offers. parse.ts turns the legacy `extraSupported`,
// `extraRequired` and `genres` into `extra`, which is always there.
export type Catalog = {
  type: ContentType;
  id: string;
  name?: string;
  extra: CatalogExtra[];
  [field: string]: unknown;
};

export type ManifestBehaviorHints = {
  adult?: boolean;
  p2p?: boolean;
  configurable?: boolean;
  // The addon answers nothing until it is configured: install it through its
  // configure page instead (#38).
  configurationRequired?: boolean;
  [field: string]: unknown;
};

export type Manifest = {
  id: string;
  name: string;
  version: string;
  description?: string;
  logo?: string;
  background?: string;
  contactEmail?: string;
  types: ContentType[];
  idPrefixes?: string[];
  resources: Resource[];
  catalogs: Catalog[];
  behaviorHints: ManifestBehaviorHints;
  [field: string]: unknown;
};

export type PosterShape = "poster" | "landscape" | "square" | (string & {});

export type MetaLink = {
  name: string;
  category: string;
  url: string;
  [field: string]: unknown;
};

// What a catalog lists: enough for a poster card.
export type MetaPreview = {
  id: string;
  type: ContentType;
  name: string;
  poster?: string;
  posterShape?: PosterShape;
  background?: string;
  logo?: string;
  description?: string;
  releaseInfo?: string;
  imdbRating?: string;
  genres?: string[];
  links?: MetaLink[];
  trailerStreams?: Stream[];
  [field: string]: unknown;
};

// An episode, or a channel's video. parse.ts reads Cinemeta's `name` into
// `title` and its `description` into `overview`.
export type Video = {
  id: string;
  title: string;
  released?: string;
  thumbnail?: string;
  season?: number;
  episode?: number;
  overview?: string;
  available?: boolean;
  streams?: Stream[];
  trailers?: Stream[];
  [field: string]: unknown;
};

export type MetaBehaviorHints = {
  // The video to play for a movie, or to open first.
  defaultVideoId?: string;
  hasScheduledVideos?: boolean;
  [field: string]: unknown;
};

// A title page's data.
export type Meta = MetaPreview & {
  videos?: Video[];
  runtime?: string;
  released?: string;
  language?: string;
  country?: string;
  awards?: string;
  website?: string;
  director?: string[];
  cast?: string[];
  writer?: string[];
  behaviorHints?: MetaBehaviorHints;
};

export type StreamBehaviorHints = {
  bingeGroup?: string;
  filename?: string;
  videoSize?: number;
  videoHash?: string;
  notWebReady?: boolean;
  countryWhitelist?: string[];
  proxyHeaders?: {
    request?: Record<string, string>;
    response?: Record<string, string>;
  };
  [field: string]: unknown;
};

// A playable source. One of `url`, `ytId`, `infoHash` or `externalUrl` is
// usually set, but parse.ts doesn't insist: newer kinds keep their own
// fields. Torrentio and TorrentsDB send only the deprecated `title`, so
// parse.ts copies it to `description` and keeps it. A `url` can embed the
// user's debrid key: never log it.
export type Stream = {
  name?: string;
  description?: string;
  // Deprecated alias of description.
  title?: string;
  url?: string;
  ytId?: string;
  infoHash?: string;
  fileIdx?: number;
  externalUrl?: string;
  sources?: string[];
  subtitles?: Subtitle[];
  behaviorHints?: StreamBehaviorHints;
  [field: string]: unknown;
};

export type Subtitle = {
  id: string;
  url: string;
  // ISO 639-2 in practice ("eng"), sometimes a name.
  lang: string;
  [field: string]: unknown;
};

// Cache hints every answer may carry, in seconds.
export type CacheHints = {
  cacheMaxAge?: number;
  staleRevalidate?: number;
  staleError?: number;
};

export type CatalogResponse = CacheHints & { metas: MetaPreview[]; hasMore?: boolean };
export type MetaResponse = CacheHints & { meta: Meta };
export type StreamResponse = CacheHints & { streams: Stream[] };
export type SubtitlesResponse = CacheHints & { subtitles: Subtitle[] };

// Extra properties for a request, such as { genre: "Drama", skip: 100 }. A
// list sends the property once per value, up to the catalog's optionsLimit.
export type Extra = Partial<Record<ExtraName, string | number | readonly string[] | undefined>>;
