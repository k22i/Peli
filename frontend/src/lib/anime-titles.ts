import { queryOptions, useQueries, useQuery, type QueryClient } from "@tanstack/react-query";

import { metaQuery, serves, type LoadedAddon, type MetaPreview } from "@/lib/addon-protocol";
import { useLoadedAddons } from "@/lib/home";
import { profileSettingsQuery } from "@/lib/settings";
import { batcher } from "@/lib/batch";
import type { TitleSearch } from "@/lib/title";
import { Service as AnimeList, type Title } from "@bindings/animelist";

// The Anime tab follows the profile's poster addon (Xperience,
// BetterPosters…; ADR-0062). AniList still picks the titles and their order,
// but each entry shows as the IMDb title it belongs to, as that addon and
// search have it: one card per show, however many seasons and cours AniList
// splits it in, with the addon's poster, name and year, opening the same
// title page search opens. Entries with no IMDb title of their own (a film
// filed as a show's special, an entry the anime list doesn't know) stay
// AniList's. Go decides which is which (animelist.Titles), a page of ids in
// one call (#128), and never waits on the anime list's download for it:
// until the list is there every card stays AniList's, and the ids are asked
// again in half a minute. Each card asks the addon for its own details as it
// mounts, so only what's on screen is asked; the answers are kept a week.

const week = 7 * 24 * 60 * 60 * 1000;

type Answer = Title & { ready: boolean };

const none: Title = { imdb: "", type: "", season: 0 };

const askTitle = batcher(async (ids: string[]): Promise<Answer[]> => {
  const answer = await AnimeList.Titles(ids);
  return ids.map((_, i) => ({ ...(answer.titles?.[i] ?? none), ready: answer.ready }));
});

// What an Anime tab id is on IMDb, or nothing: from the local anime list.
export const animeTitleQuery = (id: string) =>
  queryOptions({
    queryKey: ["anime-title", id],
    queryFn: () => askTitle(id),
    staleTime: (query) => (query.state.data?.ready === false ? 0 : week),
    refetchInterval: (query) => (query.state.data?.ready === false ? 30_000 : false),
  });

// An id the anime list can look up.
const animeId = /^(kitsu|anilist|mal):\d+$/;

// Where a followed card came from: AniList's cover, under the addon's poster
// while it loads or if it fails, and the season its entry starts.
type Origin = { cover: string | undefined; season: number };
// Kept beside the followed preview, not in it: the preview goes on to menus
// and history state as it is.
const origins = new WeakMap<MetaPreview, Origin>();

// meta as the IMDb title it belongs to: AniList's name, year and cover stand
// in until the card has the poster addon's.
function followed(meta: MetaPreview, title: Title | undefined): MetaPreview {
  if (!title?.imdb) return meta;
  const next: MetaPreview = { ...meta, id: title.imdb, type: title.type };
  origins.set(next, { cover: meta.poster, season: title.season });
  return next;
}

// The Anime tab's mapping for a list of AniList previews: follow(meta) is
// the card to show for meta, waiting(id) whether its answer is still to come.
// With no poster addon, nothing is followed. Lists that show more than one
// card per id must drop repeats after following: a show's seasons all
// become its one title.
export function useFollowAnime(addon: LoadedAddon | undefined, metas: readonly MetaPreview[]) {
  const ids = addon
    ? [...new Set(metas.map((meta) => meta.id).filter((id) => animeId.test(id)))]
    : [];
  const answers = useQueries({ queries: ids.map((id) => animeTitleQuery(id)) });
  const titles = new Map<string, { title: Title | undefined; waiting: boolean }>();
  for (const [i, id] of ids.entries()) {
    titles.set(id, { title: answers[i]?.data, waiting: answers[i]?.isPending ?? true });
  }
  return {
    follow: (meta: MetaPreview) => followed(meta, titles.get(meta.id)?.title),
    waiting: (id: string) => titles.get(id)?.waiting ?? false,
  };
}

// Follows metas and keeps the first card of each title.
export function followAll(
  metas: readonly MetaPreview[],
  follow: (meta: MetaPreview) => MetaPreview,
): MetaPreview[] {
  const seen = new Set<string>();
  const out: MetaPreview[] = [];
  for (const meta of metas) {
    const next = follow(meta);
    if (seen.has(next.id)) continue;
    seen.add(next.id);
    out.push(next);
  }
  return out;
}

// Addons that can stand in for AniList's entries: their own meta for a film
// or a show by IMDb id. Peli's built-in addons are AniList's own.
export function posterAddons(addons: readonly LoadedAddon[]): LoadedAddon[] {
  return addons.filter(
    (addon) =>
      !addon.url.startsWith("peli://") &&
      (serves(addon.manifest, "meta", "series", "tt0000000") ||
        serves(addon.manifest, "meta", "movie", "tt0000000")),
  );
}

// The profile's chosen poster addon, if it's installed and visible.
export function useAnimePosterAddon(profileId: number): LoadedAddon | undefined {
  const url = useQuery(profileSettingsQuery(profileId)).data?.animePosterAddon;
  const { addons } = useLoadedAddons(profileId);
  return url ? posterAddons(addons).find((addon) => addon.url === url) : undefined;
}

// A card as it shows: a followed one with the poster addon's details once
// they come, AniList's cover as the fallback, and the season to open on (a
// later season's entry opens there; the first, or a film, on the title
// page's own pick). Anything else as it is.
export function useAnimeCard(
  addon: LoadedAddon | undefined,
  meta: MetaPreview,
): { shown: MetaPreview; fallbackSrc: string | undefined; search: TitleSearch } {
  const origin = origins.get(meta);
  const details = useQuery({
    ...metaQuery(addon?.url ?? "", meta.type, meta.id),
    enabled: addon !== undefined && origin !== undefined,
    staleTime: week,
  }).data?.meta;
  if (!origin) return { shown: meta, fallbackSrc: undefined, search: {} };
  // The addon's own details where it has them; AniList's stand in for the rest.
  const shown: MetaPreview = details
    ? {
        ...meta,
        ...(details.name ? { name: details.name } : {}),
        ...(details.poster ? { poster: details.poster } : {}),
        ...(details.releaseInfo ? { releaseInfo: details.releaseInfo } : {}),
        ...(details.background ? { background: details.background } : {}),
        ...(details.logo ? { logo: details.logo } : {}),
        ...(details.description ? { description: details.description } : {}),
        ...(details.imdbRating ? { imdbRating: details.imdbRating } : {}),
        ...(details.genres ? { genres: details.genres } : {}),
        ...(details.released ? { released: details.released } : {}),
      }
    : meta;
  return {
    shown,
    fallbackSrc: shown.poster !== origin.cover ? origin.cover : undefined,
    search: origin.season > 1 ? { season: origin.season } : {},
  };
}

// useAnimeCard's poster ahead of the card mounting (Home's rows below the
// fold, components/media/deferred-row.tsx): the same query, so the card
// finds it in the cache.
export async function prefetchAnimePoster(
  client: QueryClient,
  addon: LoadedAddon,
  meta: MetaPreview,
): Promise<string | undefined> {
  const origin = origins.get(meta);
  if (!origin) return meta.poster;
  const details = await client.fetchQuery({
    ...metaQuery(addon.url, meta.type, meta.id),
    staleTime: week,
  });
  return details.meta?.poster || origin.cover;
}
