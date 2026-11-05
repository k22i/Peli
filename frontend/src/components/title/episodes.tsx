import { useNavigate, useSearch } from "@tanstack/react-router";
import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { WatchedItem } from "@bindings/store";
import { Chip, ChipRail } from "@/components/media/chip";
import { EpisodeList } from "@/components/title/episode-list";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Meta } from "@/lib/addon-protocol";
import {
  episodeMarks,
  isAired,
  mainEpisodes,
  seasonLabel,
  seasons as seasonsOf,
  type Episode,
  type TitleSearch,
  type titleState,
} from "@/lib/title";

// Up to this many seasons are chips on a rail; more are a menu.
const chipSeasons = 30;

// The Episodes section (#117): a header that sticks under the title bar as a
// glass strip once the episodes scroll beneath it (the Browse header's
// pattern, #116), holding the heading, the season picker and "Mark season
// watched", then the season's episodes.
export function Episodes({
  meta,
  list,
  state,
  next,
  busy,
  onMark,
  onPlay,
}: {
  meta: Meta;
  list: Episode[];
  state: ReturnType<typeof titleState>;
  next: string | undefined;
  busy: boolean;
  onMark: (items: WatchedItem[], watched: boolean) => void;
  onPlay: (episode: Episode) => void;
}) {
  const navigate = useNavigate();
  const search: TitleSearch = useSearch({ strict: false });
  const { sentinel, header, stuck } = useStuck();
  const seasons = seasonsOf(list);
  // The season asked for, else the one Play would play from, else the first.
  const season =
    (search.season !== undefined && seasons.includes(search.season) ? search.season : undefined) ??
    list.find((episode) => episode.id === next)?.season ??
    seasons[0]!;
  const shown = list.filter((episode) => episode.season === season);
  const aired = shown.filter((episode) => isAired(episode));
  const seasonWatched = aired.length > 0 && aired.every((episode) => state.watched(episode));
  // Replaced, not pushed: Back leaves the page rather than walking seasons.
  const choose = (picked: number) =>
    void navigate({ to: ".", search: { season: picked }, replace: true, resetScroll: false });

  return (
    <section aria-labelledby="episodes" className="relative flex flex-col">
      <div
        ref={sentinel}
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px"
      />
      <header
        ref={header}
        data-stuck={stuck || undefined}
        className="group/header sticky top-(--titlebar-h) z-10 mb-2 data-stuck:scroll-edge-top"
      >
        {/* Heading, rail, button in the DOM (and Tab) order; the grid puts the
            rail on its own row. Stuck, the heading steps clear of the fixed
            Back button. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 py-3 motion-safe:transition-[padding] motion-safe:duration-(--duration-base) motion-safe:ease-smooth group-data-stuck/header:glass group-data-stuck/header:py-2">
          <h2
            id="episodes"
            className="col-start-1 row-start-1 ps-gutter text-heading motion-safe:transition-[padding] motion-safe:duration-(--duration-base) motion-safe:ease-smooth group-data-stuck/header:ps-[calc(var(--spacing-gutter)+3.25rem)]"
          >
            Episodes
          </h2>
          {seasons.length > 1 && seasons.length <= chipSeasons ? (
            <ChipRail
              aria-label="Seasons"
              railClassName="col-span-2 row-start-2"
              value={[String(season)]}
              onValueChange={(value: string[]) => {
                const [picked] = value;
                if (picked !== undefined) choose(Number(picked));
              }}
            >
              {seasons.map((number) => (
                <Chip key={number} value={String(number)}>
                  {seasonLabel(number)}
                </Chip>
              ))}
            </ChipRail>
          ) : (
            seasons.length > 1 && (
              <div className="col-span-2 row-start-2 px-gutter">
                <SeasonSelect seasons={seasons} value={season} onChange={choose} />
              </div>
            )
          )}
          <Button
            variant="ghost"
            className="col-start-2 row-start-1 me-[calc(var(--spacing-gutter)-0.5rem)]"
            disabled={busy || aired.length === 0}
            onClick={() => onMark(episodeMarks(meta, aired), !seasonWatched)}
          >
            <Check className={seasonWatched ? "text-brand" : undefined} />
            {seasonWatched ? "Mark season unwatched" : "Mark season watched"}
          </Button>
        </div>
      </header>
      <EpisodeList
        key={season}
        label={seasonLabel(season)}
        episodes={shown}
        state={state}
        busy={busy}
        onPlay={onPlay}
        onMark={(episode, watched) => onMark(episodeMarks(meta, [episode]), watched)}
        onMarkEarlier={(episode, watched) => {
          const main = mainEpisodes(list);
          const earlier = main.slice(0, main.indexOf(episode));
          onMark(episodeMarks(meta, earlier), watched);
        }}
        earlier={(episode) => {
          const main = mainEpisodes(list);
          const index = main.indexOf(episode);
          if (index <= 0) return undefined;
          return main.slice(0, index).every((before) => state.watched(before));
        }}
      />
    </section>
  );
}

// Whether the header is stuck under the title bar. A 1px sentinel at the
// section's top leaves the view the moment the header sticks; the title bar
// covers the top of the window, so the view starts below it: the header's own
// `top`. (The same trick as the Browse header, #116.)
function useStuck() {
  const sentinel = useRef<HTMLDivElement | null>(null);
  const header = useRef<HTMLElement | null>(null);
  const [stuck, setStuck] = useState(false);

  useEffect(() => {
    const target = sentinel.current;
    if (!target || !header.current || typeof IntersectionObserver === "undefined") {
      return undefined;
    }
    const top = Number.parseFloat(getComputedStyle(header.current).top) || 0;
    const observer = new IntersectionObserver(
      (entries) => setStuck(!entries[entries.length - 1]!.isIntersecting),
      { rootMargin: `-${top}px 0px 0px 0px` },
    );
    observer.observe(target);
    return () => observer.disconnect();
  }, []);

  return { sentinel, header, stuck };
}

function SeasonSelect({
  seasons,
  value,
  onChange,
}: {
  seasons: number[];
  value: number;
  onChange: (season: number) => void;
}) {
  const items = seasons.map((number) => ({ value: String(number), label: seasonLabel(number) }));
  return (
    <Select
      items={items}
      value={String(value)}
      onValueChange={(next) => next !== null && onChange(Number(next))}
    >
      <SelectTrigger aria-label="Season" className="w-44">
        <SelectValue />
      </SelectTrigger>
      <SelectPopup>
        {items.map((item) => (
          <SelectItem key={item.value} value={item.value}>
            {item.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
