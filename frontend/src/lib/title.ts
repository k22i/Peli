import { queryOptions, type QueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";

import type { Watching } from "@bindings/playback";
import type { LibraryItem, Progress, WatchedItem } from "@bindings/store";
import { Service as Store } from "@bindings/store";
import {
  addonsFor,
  metaQuery,
  type ContentType,
  type LoadedAddon,
  type Meta,
  type Video,
} from "@/lib/addon-protocol";
import type { PlayTarget } from "@/lib/playback";

// The title page (#45): one film or series, its details from the first
// addon that has them, and its watched state, which follows Nuvio's apps
// (ADR-0029).

// The address of a title's page. Kitsu's anime are typed "series" or
// "movie", so a title opens by its item's own type and id.
export const titlePath = "/title/$type/$id";
export const titleParams = (meta: { type: ContentType; id: string }) => ({
  type: meta.type,
  id: meta.id,
});

// What the title page keeps in its address: the season shown.
export type TitleSearch = { season?: number };

export function titleSearch(search: Record<string, unknown>): TitleSearch {
  const raw = search["season"];
  const season =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && raw.trim()
        ? Number(raw)
        : Number.NaN;
  return Number.isInteger(season) && season >= 0 ? { season } : {};
}

// A title's details and the addon they came from, from the first of the
// profile's visible addons that serves meta for it (in the user's order)
// and answers. Each addon's answer is metaQuery's, kept across restarts, so
// a title seen before paints offline.
export const titleMetaQuery = (addons: readonly LoadedAddon[], type: ContentType, id: string) =>
  queryOptions({
    queryKey: ["title-meta", type, id, addons.map((addon) => addon.url)],
    queryFn: async ({ client }) => {
      let failure: unknown = new Error("No addon has this title.");
      for (const addon of addonsFor(addons, "meta", type, id)) {
        try {
          // One at a time, and not retried: the next addon is asked only if
          // this one fails.
          // oxlint-disable-next-line no-await-in-loop
          const { meta } = await client.fetchQuery({
            ...metaQuery(addon.url, type, id),
            retry: false,
          });
          return { addonUrl: addon.url, meta };
        } catch (error) {
          failure = error;
        }
      }
      throw failure;
    },
    retry: false,
  });

// A title's details from the cache, for titleMetaQuery's initialData: the
// first addon in its order whose answer is kept, with when that answer
// came, so a stale one still refreshes.
export function cachedTitleMeta(
  client: QueryClient,
  addons: readonly LoadedAddon[],
  type: ContentType,
  id: string,
) {
  for (const addon of addonsFor(addons, "meta", type, id)) {
    const state = client.getQueryState(metaQuery(addon.url, type, id).queryKey);
    if (state?.data) {
      return {
        initialData: { addonUrl: addon.url, meta: state.data.meta },
        initialDataUpdatedAt: state.dataUpdatedAt,
      };
    }
  }
  return {};
}

// What a profile has watched of a title, and its progress in it, under the
// surfaces' prefixes (lib/sync.ts), so a pull or an edit refreshes them.
export const titleWatchedQuery = (profileId: number, contentId: string) =>
  queryOptions({
    queryKey: ["watched", profileId, contentId],
    queryFn: async () => (await Store.TitleWatched(profileId, contentId)) ?? [],
  });

export const titleProgressQuery = (profileId: number, contentId: string) =>
  queryOptions({
    queryKey: ["progress", profileId, contentId],
    queryFn: async () => (await Store.TitleProgress(profileId, contentId)) ?? [],
  });

// Nuvio's apps count an item watched at 90 %.
const completion = 0.9;

export const isSeriesType = (type: string) =>
  ["series", "show", "tv", "tvshow"].includes(type.toLowerCase());

// An episode: a video with a season and an episode number.
export type Episode = Video & { season: number; episode: number };

export const isEpisode = (video: Video): video is Episode =>
  video.season !== undefined && video.episode !== undefined;

// A title's episodes in order: seasons 1 and up, then Specials (season 0).
const seasonOrder = (season: number) => (season === 0 ? Number.POSITIVE_INFINITY : season);

export function episodes(meta: Meta): Episode[] {
  return (meta.videos ?? [])
    .filter(isEpisode)
    .toSorted((a, b) => seasonOrder(a.season) - seasonOrder(b.season) || a.episode - b.episode);
}

// The seasons to pick from, in episodes' order.
export const seasons = (list: readonly Episode[]) => [...new Set(list.map((e) => e.season))];

export const seasonLabel = (season: number) => (season === 0 ? "Specials" : `Season ${season}`);

// Whether an episode is out. One with no date counts as out.
export function isAired(video: Video, now = Date.now()): boolean {
  if (video.released === undefined) return true;
  const released = Date.parse(video.released);
  return Number.isNaN(released) || released <= now;
}

// What counts for the whole series: the episodes out now outside Specials,
// as Nuvio's apps count them.
export const mainEpisodes = (list: readonly Episode[], now = Date.now()) =>
  list.filter((episode) => episode.season > 0 && isAired(episode, now));

// A title's watched state, from its watched marks and progress, by Nuvio's
// rules: a film or episode is watched when it's marked or its progress
// reached 90 %; below that its progress shows. A series is watched when
// every episode out outside Specials is, or when it's marked as a whole and
// there are none to count.
export type TitleState = {
  watched: (episode?: Episode) => boolean;
  // How far into a film or episode, 0 to 1, while it's under 90 %.
  progress: (episode?: Episode) => Progress | undefined;
  seriesWatched: boolean;
  marked: boolean;
};

// A watched mark's or progress entry's place in a title: "" for the title
// itself, "<season>:<episode>" for an episode.
const stateKey = (season?: number | null, episode?: number | null) =>
  season == null || episode == null ? "" : `${season}:${episode}`;

const episodeKey = (episode?: Episode) => stateKey(episode?.season, episode?.episode);

const finished = (entry: Progress | undefined) =>
  entry !== undefined && entry.duration > 0 && entry.position >= entry.duration * completion;

export function titleState(
  meta: Meta,
  marks: readonly WatchedItem[],
  progress: readonly Progress[],
  now = Date.now(),
): TitleState {
  const marked = new Set(marks.map((mark) => stateKey(mark.season, mark.episode)));
  const entries = new Map(progress.map((entry) => [stateKey(entry.season, entry.episode), entry]));
  const watched = (episode?: Episode) =>
    marked.has(episodeKey(episode)) || finished(entries.get(episodeKey(episode)));
  const main = mainEpisodes(episodes(meta), now);
  return {
    watched,
    progress: (episode) => {
      const entry = entries.get(episodeKey(episode));
      return entry && entry.position > 0 && !finished(entry) ? entry : undefined;
    },
    seriesWatched: main.length > 0 ? main.every((episode) => watched(episode)) : marked.has(""),
    marked: marked.has(""),
  };
}

// What Play does on a title page: resume the film or episode in progress
// (the latest, for a series); otherwise for a series the episode after the
// furthest one watched, or the first. Specials are played only when picked.
export type PlayChoice = { target: PlayTarget; resume: boolean; label: string };

export function playChoice(
  meta: Meta,
  state: TitleState,
  progress: readonly Progress[],
  now = Date.now(),
): PlayChoice | undefined {
  const title = meta.name;
  if (!isSeriesType(meta.type)) {
    const entry = state.progress();
    return {
      target: {
        type: meta.type,
        id: meta.id,
        title,
        videoId: meta.behaviorHints?.defaultVideoId ?? meta.id,
        resumeAt: entry?.position,
      },
      resume: entry !== undefined,
      label: entry ? "Resume" : "Play",
    };
  }

  const list = mainEpisodes(episodes(meta), now);
  const latest = progress
    .filter((entry) => state.progress(asEpisode(entry)) !== undefined)
    .toSorted((a, b) => b.lastWatched - a.lastWatched)[0];
  const resuming =
    latest && list.find((e) => e.season === latest.season && e.episode === latest.episode);
  if (resuming && latest) {
    return {
      target: episodeTarget(meta, resuming, latest.position),
      resume: true,
      label: `Resume ${episodeCode(resuming)}`,
    };
  }
  // After the last episode, from the start again.
  const furthest = list.findLastIndex((episode) => state.watched(episode));
  const next = list[furthest + 1] ?? list[0];
  if (!next) return undefined;
  return { target: episodeTarget(meta, next), resume: false, label: `Play ${episodeCode(next)}` };
}

const asEpisode = (entry: Progress): Episode | undefined =>
  entry.season == null || entry.episode == null
    ? undefined
    : { id: entry.videoId, title: "", season: entry.season, episode: entry.episode };

// "S2 · E4"
export const episodeCode = (episode: Episode) => `S${episode.season} · E${episode.episode}`;

// The player's heading (#61): the title's name, and for an episode
// "S2 · E4 · Its name" under it. Without the details, the picker's heading.
export function playerHeading(
  meta: Meta | undefined,
  videoId: string,
  fallback: string,
): { title: string; episode?: string } {
  const video = meta?.videos?.find((candidate) => candidate.id === videoId);
  if (!meta || !video || !isEpisode(video)) return { title: meta?.name ?? fallback };
  const code = episodeCode(video);
  return { title: meta.name, episode: video.title ? `${code} · ${video.title}` : code };
}

// What the player reports progress for (#64): the film or episode, named
// as Nuvio names progress and watched items. An episode's season and number
// come from the title's details, else from progress kept for it, else from
// its id ("tt0903747:2:4"); the watched item takes the episode's name.
export function watchingFor(
  profileId: number,
  target: PlayTarget,
  meta: Meta | undefined,
  progress: readonly Progress[],
): Watching {
  const videoId = target.videoId ?? target.id;
  const name = meta?.name || target.title;
  const watching: Watching = {
    profileId,
    contentId: target.id,
    contentType: target.type,
    videoId,
    title: name,
    ...trackingNames(name, meta),
  };
  if (!isSeriesType(target.type)) return watching;
  const video = meta?.videos?.find((candidate) => candidate.id === videoId);
  if (video && isEpisode(video)) {
    return {
      ...watching,
      season: video.season,
      episode: video.episode,
      title: video.title || name,
    };
  }
  const entry = progress.find(
    (candidate) => candidate.videoId === videoId && candidate.season != null,
  );
  if (entry) return { ...watching, season: entry.season ?? null, episode: entry.episode ?? null };
  const numbers = /:(\d+):(\d+)$/.exec(videoId);
  if (!numbers || !videoId.startsWith(`${target.id}:`)) return watching;
  return { ...watching, season: Number(numbers[1]), episode: Number(numbers[2]) };
}

// The meta fields SIMKL and AniList are told about (#73, #105), by their
// names there. Go adds the content id's own ("tt…", "kitsu:…") and keeps
// only well-formed ones.
const trackingFields = {
  imdb: "imdb_id",
  tmdb: "moviedb_id",
  tvdb: "tvdb_id",
  kitsu: "kitsu_id",
  mal: "mal_id",
  anilist: "anilist_id",
  anidb: "anidb_id",
} as const;

export function trackingNames(
  name: string,
  meta: Meta | undefined,
): Pick<Watching, "name" | "year" | "ids"> {
  const ids: Record<string, string> = {};
  for (const [key, field] of Object.entries(trackingFields)) {
    const value = meta?.[field];
    if (typeof value === "string" || typeof value === "number") ids[key] = String(value);
  }
  // "2008–2013" or "2023-2024": the first year is the title's.
  const released = meta?.releaseInfo ?? meta?.["year"];
  const year = Number(/\d{4}/.exec(typeof released === "string" ? released : "")?.[0]);
  return { name, ...(year ? { year } : {}), ids };
}

// Where the player starts (#64), in seconds: where the film or episode was
// left, by its progress as the store has it now (pulled from Nuvio, so
// from another device too), or the beginning if it has none or got to 90 %.
export function resumePoint(progress: readonly Progress[], watching: Watching): number {
  const key = stateKey(watching.season, watching.episode);
  const entry = progress.find((candidate) => stateKey(candidate.season, candidate.episode) === key);
  return entry && entry.position > 0 && !finished(entry) ? entry.position / 1000 : 0;
}

export function episodeTarget(meta: Meta, episode: Episode, resumeAt?: number): PlayTarget {
  return {
    type: meta.type,
    id: meta.id,
    title: `${meta.name} ${episodeCode(episode)}`,
    videoId: episode.id,
    resumeAt,
  };
}

// The marks SetWatched writes for a film or series as a whole, or for
// episodes, named as Nuvio's apps name them.
export function titleMark(meta: Meta, now = Date.now()): WatchedItem {
  return { contentId: meta.id, contentType: meta.type, title: meta.name, watchedAt: now };
}

export function episodeMarks(meta: Meta, list: readonly Episode[], now = Date.now()) {
  return list.map((episode): WatchedItem => ({
    contentId: meta.id,
    contentType: meta.type,
    title: episode.title || meta.name,
    season: episode.season,
    episode: episode.episode,
    watchedAt: now,
  }));
}

// Whether the series-level mark should be added or removed after an edit,
// so it says what the episodes say, as Nuvio's apps keep it.
export function seriesMarkChange(meta: Meta, state: TitleState): boolean | undefined {
  if (!isSeriesType(meta.type) || mainEpisodes(episodes(meta)).length === 0) return undefined;
  if (state.seriesWatched === state.marked) return undefined;
  return state.seriesWatched;
}

// The library entry for a title, from its details.
export function libraryItem(meta: Meta, addonUrl: string, now = Date.now()): LibraryItem {
  const rating = meta.imdbRating === undefined ? Number.NaN : Number.parseFloat(meta.imdbRating);
  const { poster, posterShape, background, description, releaseInfo, genres } = meta;
  return {
    contentId: meta.id,
    contentType: meta.type,
    name: meta.name,
    ...(poster && { poster }),
    ...(posterShape && { posterShape }),
    ...(background && { background }),
    ...(description && { description }),
    ...(releaseInfo && { releaseInfo }),
    ...(genres && { genres }),
    imdbRating: Number.isNaN(rating) ? null : rating,
    addonBaseUrl: addonUrl.replace(/\/manifest\.json$/, ""),
    addedAt: now,
  };
}

// What the page can show before the details arrive: the card that was
// clicked, passed in history state.
export type TitlePreview = {
  id: string;
  type: ContentType;
  name: string;
  poster?: string | undefined;
  background?: string | undefined;
  releaseInfo?: string | undefined;
  description?: string | undefined;
};

// Opens a title's page from a card, handing it the card's details, and on
// a season when one is given (the calendar's episodes, #48).
export function useOpenTitle() {
  const navigate = useNavigate();
  return (meta: TitlePreview, search: TitleSearch = {}) =>
    void navigate({
      to: titlePath,
      params: titleParams(meta),
      search,
      state: (state) => ({ ...state, title: previewOf(meta) }),
    });
}

// Only these fields: history state is kept with each entry.
const previewOf = ({
  id,
  type,
  name,
  poster,
  background,
  releaseInfo,
  description,
}: TitlePreview): TitlePreview => ({
  id,
  type,
  name,
  poster,
  background,
  releaseInfo,
  description,
});
