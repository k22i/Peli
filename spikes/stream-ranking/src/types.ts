// The slice of the Stremio addon protocol the ranker reads. #37 owns the real types.

export type Stream = {
  name?: string;
  title?: string; // deprecated alias of description; several addons still send only this
  description?: string;
  url?: string;
  ytId?: string;
  infoHash?: string;
  fileIdx?: number;
  externalUrl?: string;
  sources?: string[];
  behaviorHints?: {
    bingeGroup?: string;
    filename?: string;
    videoSize?: number;
    videoHash?: string;
    notWebReady?: boolean;
    proxyHeaders?: unknown;
    [k: string]: unknown;
  };
  [k: string]: unknown;
};

export type MediaKind = 'movie' | 'series' | 'anime';

// What we know about the requested title before any stream arrives (from /meta).
export type TitleContext = {
  slug: string;
  kind: MediaKind;
  type: 'movie' | 'series';
  id: string; // the id sent to /stream, e.g. tt0903747:1:1 or kitsu:46474:1
  name: string;
  aliases?: string[]; // other titles the release names may use (Kitsu gives these for anime)
  aliasesSource?: 'manual'; // hand-written stand-ins for TMDB's alternative titles and translations (#99)
  year?: number;
  runtimeMin?: number;
  season?: number;
  episode?: number;
  // Absolute episode number, for anime whose releases count episodes across seasons.
  absoluteEpisode?: number;
};

export type Fixture = {
  addon: string; // addon key, see record.ts
  config: 'p2p' | 'torbox';
  title: string; // TitleContext.slug
  request: string; // redacted
  recordedAt: string;
  status: number;
  ms: number;
  streams: Stream[];
};
