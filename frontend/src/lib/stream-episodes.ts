import type { Meta } from "@/lib/addon-protocol";
import { episodes, episodeTarget, type Episode } from "@/lib/title";
import type { PlayTarget } from "@/lib/playback";

// The episodes either side of the one the picker is for, in the title's
// order (Specials last), for its Previous / Next buttons. Both undefined for
// a film, an unknown episode or the ends of the list.
export function neighbours(
  meta: Meta | undefined,
  videoId: string,
): { previous?: Episode; next?: Episode } {
  if (!meta) return {};
  const list = episodes(meta);
  const index = list.findIndex((episode) => episode.id === videoId);
  if (index < 0) return {};
  return {
    ...(list[index - 1] && { previous: list[index - 1] }),
    ...(list[index + 1] && { next: list[index + 1] }),
  };
}

export const neighbourTarget = (meta: Meta, episode: Episode): PlayTarget =>
  episodeTarget(meta, episode);
