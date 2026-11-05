import { Play, X } from "lucide-react";
import { useEffect, useEffectEvent } from "react";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import type { Meta } from "@/lib/addon-protocol";
import { usePreparedNext, type PreparedNext } from "@/lib/next-episode";
import { formatTime } from "@/lib/player";
import type { ProfileSettings } from "@bindings/store";
import { resolutionLabel } from "@/lib/stream-labels";
import { episodeCode, type Episode } from "@/lib/title";
import { cn } from "@/lib/utils";

// The next-episode card (#65): mounted from where the episode counts as
// watched, it gets the next one ready and counts down to the end. Play now
// (or the end) sets `starting`; once the next is ready, or there's no
// stream for it, onStart gets what was found and the card hides. In the
// mini player (#70) it's smaller, without the thumbnail. A strong media-glass
// card (#121): the player lays it out above the control bar, at the end, and
// its text is plain white so it reads over a white frame too.
export function NextEpisode({
  profileId,
  meta,
  next,
  settings,
  remaining,
  share,
  starting,
  mini = false,
  onPlay,
  onCancel,
  onStart,
}: {
  profileId: number;
  meta: Meta;
  next: Episode;
  settings: ProfileSettings | undefined;
  // Seconds to the end, and how far through the countdown, 0 to 1.
  remaining: number;
  share: number;
  starting: boolean;
  mini?: boolean;
  onPlay: () => void;
  onCancel: () => void;
  onStart: (prepared: PreparedNext) => void;
}) {
  const prepared = usePreparedNext(profileId, meta, next, settings);
  // Once: what was found when it was due.
  const start = useEffectEvent(() => onStart(prepared));
  const finding = prepared.status === "finding";
  useEffect(() => {
    if (starting && !finding) start();
  }, [starting, finding]);
  if (starting) return null;

  const name = next.title ? `${episodeCode(next)} · ${next.title}` : episodeCode(next);
  return (
    <section
      aria-label="Next episode"
      className={cn(
        "dark flex flex-col overflow-hidden rounded-3xl text-white glass-media-strong",
        mini ? "w-64" : "w-120 max-w-full",
      )}
    >
      {next.thumbnail && !mini && (
        <div className="relative aspect-video bg-white/5">
          <img
            src={next.thumbnail}
            alt=""
            className="size-full object-cover"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
          <div className="absolute inset-x-0 bottom-0 h-1 bg-white/20">
            <div className="h-full bg-white" style={{ width: `${Math.round(share * 100)}%` }} />
          </div>
        </div>
      )}
      <div className={cn("flex flex-col", mini ? "gap-2 p-3" : "gap-3 p-4")}>
        <div className="flex min-w-0 flex-col gap-0.5">
          <p className="text-meta font-medium">
            Next episode in{" "}
            <span className="tabular-nums" aria-label={`${Math.ceil(remaining)} seconds`}>
              {formatTime(Math.ceil(remaining))}
            </span>
          </p>
          <p className="truncate text-sm font-semibold">{name}</p>
          <p aria-live="polite" className="flex items-center gap-1.5 text-meta">
            {preparedText(prepared)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            className="rounded-full border-transparent bg-white text-black hover:bg-white/90"
            onClick={onPlay}
          >
            <Play className="fill-current" />
            {prepared.status === "none" ? "Choose a stream" : "Play now"}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="rounded-full text-white hover:bg-white/15 hover:text-white"
            onClick={onCancel}
          >
            <X />
            Cancel
          </Button>
        </div>
      </div>
    </section>
  );
}

function preparedText(prepared: PreparedNext) {
  if (prepared.status === "finding") {
    return (
      <>
        <Spinner className="size-3" />
        Finding a stream…
      </>
    );
  }
  if (prepared.status === "none") return "No stream found yet";
  const { candidate, names } = prepared;
  const quality = resolutionLabel(candidate.parsed);
  const addon = names.get(candidate.source) ?? "an addon";
  return quality ? `${quality} from ${addon}` : `From ${addon}`;
}
