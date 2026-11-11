import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { Fragment } from "react";

import { sheetSurface } from "@/components/player/panel-controls";
import { Player } from "@/lib/player";
import { statsRows } from "@/lib/stats";
import { cn } from "@/lib/utils";

// How often the overlay asks Go for the numbers, while it shows.
export const statsEvery = 1000;

// The stats overlay (Shift+I, or More): what plays and how, top left over
// the video, on the sheets' surface. Go is asked once a second, and only
// while it shows (it mounts only then). It doesn't take focus or the keys.
export function StatsOverlay({ onClose }: { onClose: () => void }) {
  const stats = useQuery({
    queryKey: ["player", "stats"],
    queryFn: () => Player.Stats(),
    refetchInterval: statsEvery,
    gcTime: 0,
    staleTime: 0,
  }).data;
  return (
    <section
      aria-label="Playback stats"
      className={cn(
        "dark absolute start-5 top-28 z-10 w-[min(24rem,calc(100%-2.5rem))] rounded-3xl p-4 text-white motion-safe:animate-in motion-safe:fade-in-0",
        sheetSurface,
      )}
    >
      <div className="mb-2 flex items-center justify-between">
        <h2 className="type-eyebrow text-white/55">Playback stats</h2>
        <button
          type="button"
          aria-label="Close stats"
          aria-keyshortcuts="Shift+I"
          onClick={onClose}
          className="grid size-8 place-items-center rounded-full text-white/70 outline-none hover:bg-white/10 hover:text-white focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4"
        >
          <X />
        </button>
      </div>
      {stats ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-small">
          {statsRows(stats).map(({ label, value }) => (
            <Fragment key={label}>
              <dt className="text-white/55">{label}</dt>
              <dd className="min-w-0 font-[560] break-words tnum">{value}</dd>
            </Fragment>
          ))}
        </dl>
      ) : (
        <p className="text-small text-white/55">Reading the player…</p>
      )}
    </section>
  );
}
