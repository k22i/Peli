import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowDownCircle,
  Check,
  EllipsisVertical,
  Eye,
  EyeOff,
  Play,
  RotateCcw,
  Trash2,
  X,
} from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import type { Download } from "@bindings/store";
import { Artwork } from "@/components/media/artwork";
import { WatchProgress } from "@/components/media/cards";
import { scrollParent } from "@/components/media/poster-grid";
import { prefersReducedMotion } from "@/components/media/roving";
import { openOnContextKey } from "@/components/media/title-menu";
import { Button } from "@/components/ui/button";
import {
  ResponsiveContextMenu,
  ResponsiveMenu,
  ResponsiveMenuItem,
  ResponsiveMenuSeparator,
} from "@/components/ui/responsive-menu";
import { findingText } from "@/lib/download-pick";
import { percent, statusOf, statusText } from "@/lib/downloads";
import { useCompactShell } from "@/lib/shell-mode";
import { episodeCode, isAired, type Episode, type TitleState } from "@/lib/title";
import { cn } from "@/lib/utils";

// A row's height before it's measured: a 16:9 still about 28rem wide on a
// roomy window (#117), plus padding.
const rowPx = 252;
const rowCompactPx = 124;
const gapPx = 8;

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

// What an episode's context menu does beyond the row's own actions.
export type EpisodeMenu = {
  onPlayFromStart: (episode: Episode) => void;
  // Marks every main episode up to and including this one.
  onMarkThrough: (episode: Episode, watched: boolean) => void;
  // Whether every main episode up to and including this one is watched;
  // undefined for a special, which has no "up to here".
  through: (episode: Episode) => boolean | undefined;
  seasonWatched: boolean;
  onMarkSeason: (watched: boolean) => void;
  onClearProgress: (episode: Episode) => void;
};

// Spoiler protection (lib/spoilers.ts): whether an episode's still and
// description show blurred, and revealing it.
export type SpoilerGuard = {
  hidden: (episode: Episode) => boolean;
  reveal: (episode: Episode) => void;
};

// An episode's download (#85), for its row's glyph and its menus.
export type EpisodeDownloads = {
  // The episode's record, when it has one.
  of: (episode: Episode) => Download | undefined;
  // Whether its streams are being ranked now.
  finding: (episode: Episode) => boolean;
  download: (episode: Episode) => void;
  remove: (download: Download) => void;
  resume: (download: Download) => void;
};

// One season's episodes, scrolled with the page and virtualized, since an
// anime can list a thousand in one season. Each row plays its episode and
// has a menu to mark it, or every episode before it; right-clicking it (or
// the context-menu key, or Shift+F10) opens the fuller menu. ↑ and ↓ move
// between rows. Unaired episodes are dimmed and can't be played or marked.
export function EpisodeList({
  label,
  episodes,
  state,
  busy,
  onPlay,
  onMark,
  onMarkEarlier,
  earlier,
  menu,
  spoilers,
  downloads,
}: {
  label: string;
  episodes: readonly Episode[];
  state: TitleState;
  busy: boolean;
  onPlay: (episode: Episode) => void;
  onMark: (episode: Episode, watched: boolean) => void;
  onMarkEarlier: (episode: Episode, watched: boolean) => void;
  // Whether every main episode before this one is watched; undefined for
  // the first, or a special.
  earlier: (episode: Episode) => boolean | undefined;
  menu: EpisodeMenu;
  spoilers?: SpoilerGuard | undefined;
  downloads?: EpisodeDownloads | undefined;
}) {
  const list = useRef<HTMLOListElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [top, setTop] = useState(0);
  const compact = useCompactShell();

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return undefined;
    const parent = scrollParent(element);
    setScroller(parent);
    const update = () =>
      setTop(
        element.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop,
      );
    update();
    // jsdom has no ResizeObserver.
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    if (parent.firstElementChild) observer.observe(parent.firstElementChild);
    return () => observer.disconnect();
  }, []);

  // No React Compiler in this app: nothing here is memoized behind its back.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: episodes.length,
    getScrollElement: () => scroller,
    estimateSize: () => (compact ? rowCompactPx : rowPx),
    // Nothing laid out (jsdom, a hidden page): keep the estimate.
    measureElement: (element) =>
      element.getBoundingClientRect().height || (compact ? rowCompactPx : rowPx),
    gap: gapPx,
    scrollMargin: top,
    overscan: 4,
    // Rows scrolled to clear the sticky Episodes header above them.
    scrollPaddingStart: 176,
    scrollPaddingEnd: 32,
    initialRect: { width: 0, height: window.innerHeight },
  });

  const focusRow = (index: number) => {
    const target = () =>
      list.current?.querySelector<HTMLElement>(`[data-episode-index="${index}"]`);
    const found = target();
    if (found) {
      found.focus({ preventScroll: true });
      found.scrollIntoView?.({
        block: "nearest",
        behavior: prefersReducedMotion() ? "auto" : "smooth",
      });
      return;
    }
    virtualizer.scrollToIndex(index);
    requestAnimationFrame(() => target()?.focus());
  };
  const onRowKeyDown = (index: number, event: KeyboardEvent<HTMLElement>) => {
    const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    const to = index + step;
    if (!step || to < 0 || to >= episodes.length) return;
    event.preventDefault();
    focusRow(to);
  };

  return (
    <ol
      ref={list}
      aria-label={label}
      className="relative px-page"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const episode = episodes[item.index]!;
        return (
          <li
            key={episode.id}
            ref={virtualizer.measureElement}
            data-index={item.index}
            // The still lines up with the page text; the row's hover fill
            // reaches past it (the row's own padding).
            className="absolute inset-x-[calc(var(--spacing-page)-0.75rem)] top-0"
            style={{ transform: `translateY(${item.start - top}px)` }}
          >
            <EpisodeRow
              index={item.index}
              episode={episode}
              state={state}
              busy={busy}
              earlier={earlier(episode)}
              menu={menu}
              downloads={downloads}
              spoiler={spoilers?.hidden(episode) ?? false}
              onReveal={() => spoilers?.reveal(episode)}
              onPlay={() => onPlay(episode)}
              onMark={(watched) => onMark(episode, watched)}
              onMarkEarlier={(watched) => onMarkEarlier(episode, watched)}
              onKeyDown={(event) => onRowKeyDown(item.index, event)}
            />
          </li>
        );
      })}
    </ol>
  );
}

function EpisodeRow({
  index,
  episode,
  state,
  busy,
  earlier,
  menu,
  downloads,
  spoiler,
  onReveal,
  onPlay,
  onMark,
  onMarkEarlier,
  onKeyDown,
}: {
  index: number;
  episode: Episode;
  state: TitleState;
  busy: boolean;
  earlier: boolean | undefined;
  menu: EpisodeMenu;
  // Downloading the episode; none on a page that doesn't offer it.
  downloads: EpisodeDownloads | undefined;
  // Spoiler protection: the still and description blurred until revealed.
  spoiler: boolean;
  onReveal: () => void;
  onPlay: () => void;
  onMark: (watched: boolean) => void;
  onMarkEarlier: (watched: boolean) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const trigger = useRef<HTMLDivElement>(null);
  const aired = isAired(episode);
  const watched = state.watched(episode);
  const entry = state.progress(episode);
  // Downloaded, downloading: a row says so beside its watched mark (#85).
  // An unaired episode has no download.
  const download = aired ? downloads?.of(episode) : undefined;
  const code = episodeCode(episode);
  const title = episode.title || `Episode ${episode.episode}`;
  const released = episode.released ? Date.parse(episode.released) : Number.NaN;
  const runtime = typeof episode["runtime"] === "string" ? episode["runtime"] : undefined;
  // "S1 · E3 · 52 min · 4 Mar 2008"; unaired, the air date takes the runtime's
  // place: "S1 · E3 · Airs 4 Mar 2008".
  const line = [
    code,
    aired ? runtime : undefined,
    Number.isNaN(released) ? undefined : `${aired ? "" : "Airs "}${date.format(released)}`,
  ].filter(Boolean);

  const row = (
    <div className="group/episode flex items-center gap-4 rounded-2xl p-3 ios-compact:gap-1 ios-compact:p-1.5 transition-[background-color,scale] duration-(--duration-fast) hover:bg-foreground/4 motion-safe:has-[[data-episode-index]:active]:scale-[0.995]">
      <button
        type="button"
        data-episode-index={index}
        disabled={!aired}
        aria-label={`${code}: ${title}${
          watched ? ", watched" : entry ? ", in progress" : ""
        }${download ? (statusOf(download) === "done" ? ", downloaded" : ", downloading") : ""}`}
        onClick={onPlay}
        onKeyDown={(event) => {
          if (!openOnContextKey(event)) onKeyDown(event);
        }}
        className="group/play flex min-w-0 flex-1 scroll-mt-[calc(var(--spacing-bar)+8rem)] scroll-mb-8 cursor-pointer items-center gap-6 ios-compact:gap-3 rounded-xl text-start outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <span
          aria-hidden
          className={cn(
            "w-9 shrink-0 text-end ios-compact:hidden font-display text-[2.5rem] leading-none tnum transition-colors",
            watched ? "text-faint" : "text-muted-foreground group-hover/episode:text-foreground",
          )}
        >
          {episode.episode}
        </span>
        <span className="relative aspect-video w-[clamp(11rem,20vw,16.5rem)] ios-compact:w-32 shrink-0 overflow-hidden rounded-card shadow-card">
          <Artwork
            src={episode.thumbnail}
            use="landscape"
            title={title}
            className={cn(
              !aired && "opacity-60",
              spoiler && "scale-110 blur-xl motion-safe:transition-[filter,scale]",
            )}
          />
          {entry && <WatchProgress value={entry.position / entry.duration} />}
          {watched && (
            <span className="absolute end-2 top-2 grid size-6 place-items-center rounded-full bg-black/60 text-white backdrop-blur-md">
              <Check className="size-3.5" strokeWidth={3} aria-hidden />
            </span>
          )}
          {download && <RowDownloadGlyph download={download} />}
          {aired && (
            <span
              aria-hidden
              className="absolute top-1/2 left-1/2 grid size-11 -translate-x-1/2 -translate-y-1/2 scale-90 place-items-center rounded-full bg-white text-black opacity-0 shadow-float transition-[opacity,scale] duration-(--duration-base) ease-out-soft group-hover/episode:scale-100 group-hover/episode:opacity-100 group-focus-visible/play:scale-100 group-focus-visible/play:opacity-100"
            >
              <Play className="size-4.5 translate-x-px fill-current" />
            </span>
          )}
        </span>
        <span className="flex max-w-3xl min-w-0 flex-col gap-1">
          <span
            className={cn(
              "text-[0.9375rem] font-[620] tracking-[-0.01em]",
              aired ? "text-foreground" : "text-muted-foreground",
            )}
          >
            {title}
          </span>
          <span className="text-small text-muted-foreground tnum">{line.join(" · ")}</span>
          {episode.overview &&
            (spoiler ? (
              // Blurred and out of reach of a screen reader until revealed.
              <span
                aria-hidden
                data-testid="spoiler-overview"
                className="mt-1 line-clamp-2 text-body text-pretty text-muted-foreground blur-[5px] select-none"
              >
                {episode.overview}
              </span>
            ) : (
              <span className="mt-1 line-clamp-2 text-body text-pretty text-muted-foreground">
                {episode.overview}
              </span>
            ))}
        </span>
      </button>
      {spoiler && (episode.thumbnail || episode.overview) && (
        <Button
          variant="ghost"
          size="icon"
          aria-label={`Reveal ${code}`}
          title="Reveal the picture and description"
          className="opacity-70 group-hover/episode:opacity-100"
          onClick={(event) => {
            // The button goes once it's revealed: focus stays on the row.
            const play = event.currentTarget.parentElement?.querySelector<HTMLElement>(
              "[data-episode-index]:not(:disabled)",
            );
            onReveal();
            play?.focus();
          }}
        >
          <Eye />
        </Button>
      )}
      {aired && (
        <ResponsiveMenu
          label={`${code} ${title}`}
          header={<EpisodeSheetHeader code={code} title={title} />}
          align="end"
          popupClassName="w-60"
          trigger={{
            render: (
              <Button
                variant="ghost"
                size="icon"
                aria-label={`More for ${code}`}
                disabled={busy}
                className="opacity-70 group-hover/episode:opacity-100"
              />
            ),
            children: <EllipsisVertical />,
          }}
        >
          {downloads && <DownloadMenuItems episode={episode} downloads={downloads} />}
          <ResponsiveMenuItem onClick={() => onMark(!watched)}>
            {watched ? "Mark unwatched" : "Mark watched"}
          </ResponsiveMenuItem>
          {earlier !== undefined && (
            <ResponsiveMenuItem onClick={() => onMarkEarlier(!earlier)}>
              {earlier ? "Mark earlier episodes unwatched" : "Mark earlier episodes watched"}
            </ResponsiveMenuItem>
          )}
        </ResponsiveMenu>
      )}
    </div>
  );
  if (!aired) return row;

  const through = menu.through(episode);
  return (
    <ResponsiveContextMenu
      triggerRef={trigger}
      label={`${code} ${title}`}
      header={<EpisodeSheetHeader code={code} title={title} />}
      popupClassName="material-pop w-64"
      finalFocus={() => trigger.current?.querySelector<HTMLElement>("[data-episode-index]") ?? true}
      items={
        <>
          <ResponsiveMenuItem onClick={onPlay}>
            {entry ? <RotateCcw aria-hidden /> : <Play aria-hidden className="fill-current" />}
            {entry ? "Resume" : "Play"}
          </ResponsiveMenuItem>
          {entry && (
            <ResponsiveMenuItem onClick={() => menu.onPlayFromStart(episode)}>
              <Play aria-hidden className="fill-current" />
              Play from start
            </ResponsiveMenuItem>
          )}
          {downloads && (
            <>
              <ResponsiveMenuSeparator />
              <DownloadMenuItems episode={episode} downloads={downloads} />
            </>
          )}
          <ResponsiveMenuSeparator />
          <ResponsiveMenuItem disabled={busy} onClick={() => onMark(!watched)}>
            {watched ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
            {watched ? "Mark unwatched" : "Mark watched"}
          </ResponsiveMenuItem>
          {through !== undefined && (
            <ResponsiveMenuItem
              disabled={busy}
              onClick={() => menu.onMarkThrough(episode, !through)}
            >
              <Check aria-hidden />
              {through ? "Mark all up to here unwatched" : "Mark all up to here watched"}
            </ResponsiveMenuItem>
          )}
          <ResponsiveMenuItem
            disabled={busy}
            onClick={() => menu.onMarkSeason(!menu.seasonWatched)}
          >
            <Check aria-hidden />
            {menu.seasonWatched ? "Mark season unwatched" : "Mark season watched"}
          </ResponsiveMenuItem>
          {entry && (
            <>
              <ResponsiveMenuSeparator />
              <ResponsiveMenuItem onClick={() => menu.onClearProgress(episode)}>
                <X aria-hidden />
                Clear progress
              </ResponsiveMenuItem>
            </>
          )}
        </>
      }
    >
      {row}
    </ResponsiveContextMenu>
  );
}

// The top of an episode's sheet on the iPhone: its code and title.
function EpisodeSheetHeader({ code, title }: { code: string; title: string }) {
  return (
    <div className="flex flex-col gap-0.5 border-b px-5 pb-3">
      <span className="text-[13px] leading-4 font-[560] text-muted-foreground uppercase tnum">
        {code}
      </span>
      <span className="line-clamp-2 text-[17px] leading-[22px] font-[620] tracking-[-0.01em]">
        {title}
      </span>
    </div>
  );
}

// A row's download mark (#85): a filled arrow-down-circle once downloaded,
// the percent while it runs, an arrow while it waits.
function RowDownloadGlyph({ download }: { download: Download }) {
  const status = statusOf(download);
  const done = percent(download);
  const running = status === "downloading" && done !== undefined;
  return (
    <span
      aria-hidden
      data-testid="episode-download"
      className="absolute start-2 top-2 grid h-6 min-w-6 place-items-center rounded-full bg-black/60 px-1 text-white backdrop-blur-md"
    >
      {running ? (
        <span className="text-[0.625rem] leading-none font-[650] tnum">{done}%</span>
      ) : status === "done" ? (
        <ArrowDownCircle className="size-3.5" strokeWidth={2.5} />
      ) : (
        <ArrowDown className="size-3.5" strokeWidth={2.5} />
      )}
    </span>
  );
}

// An episode's download items (#85): what's to come, where it is, and the way
// back out.
function DownloadMenuItems({
  episode,
  downloads,
}: {
  episode: Episode;
  downloads: EpisodeDownloads;
}) {
  const download = downloads.of(episode);
  if (!download) {
    const finding = downloads.finding(episode);
    return (
      <ResponsiveMenuItem disabled={finding} onClick={() => downloads.download(episode)}>
        <ArrowDown aria-hidden />
        {finding ? findingText : "Download"}
      </ResponsiveMenuItem>
    );
  }
  const status = statusOf(download);
  const stopped = status === "paused" || status === "failed";
  return (
    <>
      <ResponsiveMenuItem disabled>
        <ArrowDownCircle aria-hidden />
        {statusText(download)}
      </ResponsiveMenuItem>
      {stopped && (
        <ResponsiveMenuItem onClick={() => downloads.resume(download)}>
          <RotateCcw aria-hidden />
          Resume download
        </ResponsiveMenuItem>
      )}
      <ResponsiveMenuItem onClick={() => downloads.remove(download)}>
        <Trash2 aria-hidden />
        Remove download
      </ResponsiveMenuItem>
    </>
  );
}
