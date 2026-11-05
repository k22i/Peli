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

// The map of `video`, and whether it may still come: for a Kitsu video, until
// the addons have loaded and one has answered. A video with none, or an
// addon that fails, settles with no map and `pending` false, so callers that
// wait for it (the next-episode pick) never hang.
export function useEpisodeMap(
  addons: readonly LoadedAddon[],
  loading: boolean,
  type: ContentType,
  id: string,
  video: string,
): { map: EpisodeMap | undefined; pending: boolean } {
  const kitsu = video.startsWith("kitsu:");
  const query = useQuery({
    ...episodeMapQuery(addons, type, id, video),
    enabled: !loading && kitsu,
  });
  return { map: query.data ?? undefined, pending: kitsu && (loading || query.isPending) };
}
