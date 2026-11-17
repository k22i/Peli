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
import { promptEnter, promptSurface } from "@/components/player/prompt";
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
  compact = false,
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
  // The touch player's (#130): 240 pt wide, without the thumbnail.
  compact?: boolean;
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
  // The countdown runs out along the Play button: it fills as the card waits.
  const fill = Math.round(Math.min(Math.max(share, 0), 1) * 100);
  return (
    <section
      aria-label="Next episode"
      className={cn(
        promptSurface,
        promptEnter,
        "dark flex overflow-hidden",
        mini ? "w-64 flex-col" : compact ? "w-60 flex-col" : "w-[26rem] max-w-full items-stretch",
      )}
    >
      {next.thumbnail && !mini && !compact && (
        <div className="relative w-40 shrink-0 bg-white/5">
          <img
            src={next.thumbnail}
            alt=""
            className="absolute inset-0 size-full object-cover"
            onError={(event) => {
              event.currentTarget.hidden = true;
            }}
          />
        </div>
      )}
      <div
        className={cn("flex min-w-0 flex-1 flex-col", mini || compact ? "gap-2 p-3" : "gap-3 p-4")}
      >
        <div className="flex min-w-0 flex-col gap-1">
          <p className="type-eyebrow text-[#ffc46b]">
            Up next ·{" "}
            <span className="tnum" aria-label={`in ${Math.ceil(remaining)} seconds`}>
              {formatTime(Math.ceil(remaining))}
            </span>
          </p>
          <p className="line-clamp-2 text-[0.9375rem] leading-snug font-[620]">{name}</p>
          <p aria-live="polite" className="flex items-center gap-1.5 text-small text-white/60">
            {preparedText(prepared)}
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            size="sm"
            variant="light"
            className="relative flex-1 overflow-hidden"
            onClick={onPlay}
          >
            <span
              aria-hidden
              className="absolute inset-y-0 start-0 bg-black/10"
              style={{ width: `${fill}%` }}
            />
            <Play className="relative fill-current" />
            <span className="relative">
              {prepared.status === "none" ? "Choose a stream" : "Play now"}
            </span>
          </Button>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label="Cancel"
            className="text-white/70 hover:bg-white/12 hover:text-white"
            onClick={onCancel}
          >
            <X />
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
