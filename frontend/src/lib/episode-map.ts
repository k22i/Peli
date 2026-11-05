import { queryOptions, useQuery } from "@tanstack/react-query";

import { addonsFor, metaQuery, type ContentType, type LoadedAddon } from "@/lib/addon-protocol";
import { episodeMapOf, type EpisodeMap } from "@/lib/ranking";

// The numbers a Kitsu episode has by season (#100, ADR-0050), so the ranking
// can tell "S22E15" from another season's episode 15 for a long runner like
// One Piece episode 1100. The Kitsu addon sends them on each video of its
// details; the AniList addon, which usually answers a title's details first,
// doesn't. So this asks the addons that serve the title's details one at a
// time (the answers are the title page's, mostly cached) until one has a map
// for the video. Null for none, and for ids that aren't Kitsu's.
export const episodeMapQuery = (
  addons: readonly LoadedAddon[],
  type: ContentType,
  id: string,
  video: string,
) =>
  queryOptions({
    queryKey: ["episode-map", type, id, video, addons.map((addon) => addon.url)],
    queryFn: async ({ client }): Promise<EpisodeMap | null> => {
      for (const addon of addonsFor(addons, "meta", type, id)) {
        try {
          // One at a time: the next addon is asked only if this one has no map.
          // oxlint-disable-next-line no-await-in-loop
          const { meta } = await client.fetchQuery({
            ...metaQuery(addon.url, type, id),
            retry: false,
          });
          const map = episodeMapOf(meta, video);
          if (map) return map;
        } catch {
          // Try the next addon.
        }
      }
      return null;
    },
    staleTime: 60 * 60 * 1000,
    retry: false,
  });

// The map of `video`, once the addons have loaded; undefined until it's
// found, or when there is none.
export function useEpisodeMap(
  addons: readonly LoadedAddon[],
  loading: boolean,
  type: ContentType,
  id: string,
  video: string,
): EpisodeMap | undefined {
  const { data } = useQuery({
    ...episodeMapQuery(addons, type, id, video),
    enabled: !loading && video.startsWith("kitsu:"),
  });
  return data ?? undefined;
}
