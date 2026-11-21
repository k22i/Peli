import { useNavigate, useSearch } from "@tanstack/react-router";
import { ArrowDown, Check, Ellipsis, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { Download, WatchedItem } from "@bindings/store";
import { Chip, ChipRail } from "@/components/media/chip";
import {
  EpisodeList,
  type EpisodeDownloads,
  type SpoilerGuard,
} from "@/components/title/episode-list";
import { Button } from "@/components/ui/button";
import { ResponsiveMenu, ResponsiveMenuItem } from "@/components/ui/responsive-menu";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  downloadSeason,
  downloadTarget,
  type TitleDownloads,
} from "@/lib/download-pick";
import { downloadFor } from "@/lib/downloads";
import { haptic } from "@/lib/haptics";
import type { Meta } from "@/lib/addon-protocol";
import { useCompactShell } from "@/lib/shell-mode";
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

// What a season and its rows download with (#85): the title's queue and its
// profile's records, and the addon whose details served the title.
export type EpisodesDownload = { downloads: TitleDownloads; metaAddon: string };

// The Episodes section (#117): a header that sticks under the title bar as a
// material-pop strip once the episodes scroll beneath it (the Browse header's
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
  onPlayFromStart,
  onClearProgress,
  spoilers,
  download,
}: {
  meta: Meta;
  list: Episode[];
  state: ReturnType<typeof titleState>;
  next: string | undefined;
  busy: boolean;
  onMark: (items: WatchedItem[], watched: boolean) => void;
  onPlay: (episode: Episode) => void;
  onPlayFromStart: (episode: Episode) => void;
  onClearProgress: (episode: Episode) => void;
  // Spoiler protection: which episodes show blurred, and revealing one.
  spoilers?: SpoilerGuard;
  // Downloading the season, and each of its episodes (#85).
  download?: EpisodesDownload | undefined;
}) {
  const navigate = useNavigate();
  // The phone (#136): a 22 pt heading, and "Mark season watched" in a "•••".
  const compact = useCompactShell();
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

  // The season's downloads (#85): what's already downloaded, what's left to
  // queue, and each row's own.
  const seasonDownloads: Download[] = download
    ? shown.flatMap((episode) => {
        const entry = downloadFor(download.downloads.list, episode.id);
        return entry ? [entry] : [];
      })
    : [];
  const toDownload = download
    ? aired.filter((episode) => !downloadFor(download.downloads.list, episode.id))
    : [];
  const episodeDownloads: EpisodeDownloads | undefined =
    download && {
      of: (episode: Episode) => downloadFor(download.downloads.list, episode.id),
      finding: (episode: Episode) => download.downloads.queue.finding(episode.id),
      download: (episode: Episode) =>
        download.downloads.queue.download(
          downloadTarget(meta, download.metaAddon, episode),
        ),
      remove: (entry: Download) => void download.downloads.actions.remove([entry.id]),
      resume: (entry: Download) => void download.downloads.actions.resume(entry.id),
    };

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
        className="group/header sticky ios-short:static top-(--spacing-bar) z-10 mb-1 transition-[background-color,box-shadow] duration-(--duration-base) data-stuck:material-bar data-stuck:shadow-[0_1px_0_var(--border)]"
      >
        {/* Heading, rail, button in the DOM (and Tab) order; the grid puts the
            rail on its own row. Stuck, the heading steps clear of the fixed
            Back button. */}
        <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-6 gap-y-3 py-3 motion-safe:transition-[padding] motion-safe:duration-(--duration-base) motion-safe:ease-out-soft group-data-stuck/header:py-2">
          <h2
            id="episodes"
            className="col-start-1 row-start-1 ps-page font-display text-[2.25rem] leading-none motion-safe:transition-[padding,font-size] motion-safe:duration-(--duration-base) motion-safe:ease-out-soft group-data-stuck/header:ps-[calc(var(--spacing-page)+3.25rem)] group-data-stuck/header:text-[1.75rem] ios-compact:text-[1.375rem] ios-compact:group-data-stuck/header:ps-page ios-compact:group-data-stuck/header:text-[1.375rem]"
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
              <div className="col-span-2 row-start-2 px-page">
                <SeasonSelect seasons={seasons} value={season} onChange={choose} />
              </div>
            )
          )}
          {compact ? (
            <ResponsiveMenu
              label={seasonLabel(season)}
              align="end"
              popupClassName="w-60"
              trigger={{
                render: (
                  <Button
                    variant="ghost"
                    size="icon-lg"
                    aria-label={`More for ${seasonLabel(season)}`}
                    className="col-start-2 row-start-1 me-1 size-11 sm:size-11"
                  />
                ),
                children: <Ellipsis />,
              }}
            >
              <ResponsiveMenuItem
                disabled={busy || aired.length === 0}
                onClick={() => onMark(episodeMarks(meta, aired), !seasonWatched)}
              >
                <Check />
                {seasonWatched ? "Mark season unwatched" : "Mark season watched"}
              </ResponsiveMenuItem>
              {download && (
                <SeasonDownloadItems
                  aired={aired}
                  download={download}
                  meta={meta}
                  toDownload={toDownload}
                  seasonDownloads={seasonDownloads}
                />
              )}
            </ResponsiveMenu>
          ) : (
            <div className="col-start-2 row-start-1 me-page flex items-center gap-2">
              <Button
                variant="secondary"
                disabled={busy || aired.length === 0}
                onClick={() => onMark(episodeMarks(meta, aired), !seasonWatched)}
              >
                <Check className={seasonWatched ? "text-sun-ink opacity-100" : undefined} />
                {seasonWatched ? "Mark season unwatched" : "Mark season watched"}
              </Button>
              {download && (
                <SeasonDownloadButtons
                  aired={aired}
                  download={download}
                  meta={meta}
                  toDownload={toDownload}
                  seasonDownloads={seasonDownloads}
                />
              )}
            </div>
          )}
        </div>
      </header>
      <EpisodeList
        key={season}
        label={seasonLabel(season)}
        episodes={shown}
        state={state}
        busy={busy}
        spoilers={spoilers}
        downloads={episodeDownloads}
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
        menu={{
          onPlayFromStart,
          onClearProgress,
          seasonWatched,
          onMarkSeason: (watched) => onMark(episodeMarks(meta, aired), watched),
          // A special has no "up to here": the main episodes aren't before it.
          through: (episode) => {
            const main = mainEpisodes(list);
            const index = main.indexOf(episode);
            if (index < 0) return undefined;
            return main.slice(0, index + 1).every((before) => state.watched(before));
          },
          onMarkThrough: (episode, watched) => {
            const main = mainEpisodes(list);
            onMark(episodeMarks(meta, main.slice(0, main.indexOf(episode) + 1)), watched);
          },
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
      onValueChange={(next) => {
        if (next === null) return;
        haptic("selection");
        onChange(Number(next));
      }}
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

// A season's download actions in the phone's "•••" sheet (#85).
function SeasonDownloadItems({ aired, download, meta, seasonDownloads, toDownload }: SeasonActions) {
  return (
    <>
      <ResponsiveMenuItem
        disabled={toDownload.length === 0}
        onClick={() => downloadSeason(download.downloads, meta, download.metaAddon, aired)}
      >
        <ArrowDown />
        Download season
      </ResponsiveMenuItem>
      {seasonDownloads.length > 0 && (
        <ResponsiveMenuItem onClick={() => removeSeason(download, seasonDownloads)}>
          <Trash2 />
          Remove season downloads
        </ResponsiveMenuItem>
      )}
    </>
  );
}

// The same beside the season's Mark button, where there's room (#117).
function SeasonDownloadButtons({
  aired,
  download,
  meta,
  seasonDownloads,
  toDownload,
}: SeasonActions) {
  return (
    <>
      <Button
        variant="ghost"
        disabled={toDownload.length === 0}
        onClick={() => downloadSeason(download.downloads, meta, download.metaAddon, aired)}
      >
        <ArrowDown />
        Download season
      </Button>
      {seasonDownloads.length > 0 && (
        <Button variant="ghost" onClick={() => removeSeason(download, seasonDownloads)}>
          <Trash2 />
          Remove season downloads
        </Button>
      )}
    </>
  );
}

type SeasonActions = {
  // The season's aired episodes: only they can be downloaded.
  aired: readonly Episode[];
  download: EpisodesDownload;
  meta: Meta;
  // The aired episodes with no download yet.
  toDownload: readonly Episode[];
  seasonDownloads: readonly Download[];
};

// One call for the whole season: a season's episode at a time, or all at
// once, through Go's own queue.
function removeSeason({ downloads }: EpisodesDownload, entries: readonly Download[]) {
  void downloads.actions.remove(entries.map((entry) => entry.id));
}
