import { queryOptions, useQuery } from "@tanstack/react-query";

import { metaQuery, serves, type LoadedAddon } from "@/lib/addon-protocol";
import { useLoadedAddons } from "@/lib/home";
import { profileSettingsQuery } from "@/lib/settings";
import { batcher } from "@/lib/batch";
import { Service as AnimeList, type PosterTitle } from "@bindings/animelist";

// Posters for the Anime tab from another addon (BetterPosters, Xperience…),
// while the catalog, its order and the details stay AniList's. Only where an
// AniList entry is one film or show to that addon: a later season, a cour
// or a show AniList splits in several would get the whole show's poster,
// which stands for none of them, so those keep AniList's cover (Go decides,
// animelist.PosterTitles). Each card asks for its own poster as it mounts, so
// only what's on screen is asked, and the answers are kept for a week. The
// cards of a page ask Go in one call (#128), and Go never waits on the anime
// list's download for it: until the list is there every card keeps
// AniList's cover, and the titles are asked again in half a minute.

const week = 7 * 24 * 60 * 60 * 1000;

type Answer = PosterTitle & { ready: boolean };

const askTitle = batcher(async (ids: string[]): Promise<Answer[]> => {
  const answer = await AnimeList.PosterTitles(ids);
  return ids.map((_, i) => ({
    ...(answer.titles?.[i] ?? { imdb: "", type: "" }),
    ready: answer.ready,
  }));
});

// What an Anime tab id is to IMDb, or nothing: from the local anime list.
export const posterTitleQuery = (id: string) =>
  queryOptions({
    queryKey: ["anime-poster-title", id],
    queryFn: () => askTitle(id),
    staleTime: (query) => (query.state.data?.ready === false ? 0 : week),
    refetchInterval: (query) => (query.state.data?.ready === false ? 30_000 : false),
  });

// An id the anime list can look up.
const animeId = /^(kitsu|anilist|mal):\d+$/;

// Addons that can give a poster for an IMDb title: their own meta for a
// film or a show by IMDb id. Peli's built-in addons are AniList's own.
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

// A card's poster from addon, or undefined to keep its own: while the
// answers come, when the entry isn't one title to IMDb, or when the addon
// has no poster for it.
export function useAnimePoster(addon: LoadedAddon | undefined, id: string): string | undefined {
  const asks = addon !== undefined && animeId.test(id);
  const title = useQuery({ ...posterTitleQuery(id), enabled: asks }).data;
  const imdb = title?.imdb ?? "";
  const meta = useQuery({
    ...metaQuery(addon?.url ?? "", title?.type || "series", imdb),
    enabled: asks && imdb !== "",
    staleTime: week,
  }).data;
  return asks && imdb ? meta?.meta?.poster || undefined : undefined;
}
