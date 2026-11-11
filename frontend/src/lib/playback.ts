import { useNavigate } from "@tanstack/react-router";

import type { ContentType } from "@/lib/addon-protocol";
import { isSeriesType, titleParams, titlePath } from "@/lib/title";

// What to play: a title, an episode of it, and where to pick up.
export type PlayTarget = {
  type: ContentType;
  // The title's id, as addons know it.
  id: string;
  title: string;
  // The episode (or a film's video) to play. A film without one plays its
  // own id.
  videoId?: string | undefined;
  // Where to resume, in milliseconds.
  resumeAt?: number | undefined;
  // Play from the beginning whatever progress is stored ("Play from start").
  startOver?: boolean | undefined;
};

// The stream picker's address (#50): the title, with the video and resume
// point in its search, and the target in history state for its heading.
export const streamsPath = "/streams/$type/$id";

export type StreamsSearch = { video?: string; at?: number };

export function streamsSearch(search: Record<string, unknown>): StreamsSearch {
  const video = search["video"];
  const at = search["at"];
  return {
    ...(typeof video === "string" && video ? { video } : {}),
    ...(typeof at === "number" && Number.isFinite(at) && at > 0 ? { at } : {}),
  };
}

// The id streams are asked for: the episode's, or the film's.
export const streamId = (target: Pick<PlayTarget, "id" | "videoId">) => target.videoId ?? target.id;

// The one way to start playback, so Home's hero and Continue Watching (#42),
// the title page (#45) and the library (#46) don't each decide it. It opens
// the stream picker (#50, ranked by #52); the player (#60, resuming #64)
// takes it from there: launch, a click here, then a stream, keeps "launch to
// playing" within three clicks (#40). A series without an episode opens its
// title page instead, to choose one.
export function usePlay() {
  const navigate = useNavigate();
  return (target: PlayTarget) => {
    if (!target.videoId && isSeriesType(target.type)) {
      void navigate({ to: titlePath, params: titleParams(target) });
      return;
    }
    void navigate({
      to: streamsPath,
      params: { type: target.type, id: target.id },
      search: streamsSearch({ video: target.videoId, at: target.resumeAt }),
      state: (state) => ({ ...state, play: target }),
    });
  };
}
