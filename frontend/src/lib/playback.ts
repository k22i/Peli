import { toastManager } from "@/components/ui/toast";
import type { ContentType } from "@/lib/addon-protocol";

// What to play: a title, an episode of it, and where to pick up.
export type PlayTarget = {
  type: ContentType;
  // The title's id, as addons know it.
  id: string;
  title: string;
  // The episode (or a film's video) to play; the stream picker chooses for a
  // title with none.
  videoId?: string | undefined;
  // Where to resume, in milliseconds.
  resumeAt?: number | undefined;
};

// The one way to start playback, so Home's hero and Continue Watching (#42),
// the title page (#45) and the library (#46) don't each decide it. The
// stream picker (#52) and the player (#60, resuming #64) fill it in: launch, a click here,
// then a stream, keeps "launch to playing" within three clicks (#40). Until
// then it says so.
export function usePlay() {
  return (target: PlayTarget) => {
    toastManager.add({
      title: `Can’t play ${target.title} yet`,
      description: "Sinag’s player isn’t built yet.",
    });
  };
}
