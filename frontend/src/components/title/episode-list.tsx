import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, EllipsisVertical, Eye, EyeOff, Play, RotateCcw, X } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { Artwork } from "@/components/media/artwork";
import { WatchProgress } from "@/components/media/cards";
import { scrollParent } from "@/components/media/poster-grid";
import { prefersReducedMotion } from "@/components/media/roving";
import { openOnContextKey } from "@/components/media/title-menu";
import { Button } from "@/components/ui/button";
import {
  ContextMenu,
  ContextMenuItem,
  ContextMenuPopup,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
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
  onPlay: () => void;
  onMark: (watched: boolean) => void;
  onMarkEarlier: (watched: boolean) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const trigger = useRef<HTMLDivElement>(null);
  const aired = isAired(episode);
  const watched = state.watched(episode);
  const entry = state.progress(episode);
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
        aria-label={`${code}: ${title}${watched ? ", watched" : entry ? ", in progress" : ""}`}
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
            className={cn(!aired && "opacity-60")}
          />
          {entry && <WatchProgress value={entry.position / entry.duration} />}
          {watched && (
            <span className="absolute end-2 top-2 grid size-6 place-items-center rounded-full bg-black/60 text-white backdrop-blur-md">
              <Check className="size-3.5" strokeWidth={3} aria-hidden />
            </span>
          )}
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
          {episode.overview && (
            <span className="mt-1 line-clamp-2 text-body text-pretty text-muted-foreground">
              {episode.overview}
            </span>
          )}
        </span>
      </button>
      {aired && (
        <Menu>
          <MenuTrigger
            render={
              <Button
                variant="ghost"
                size="icon"
                aria-label={`More for ${code}`}
                disabled={busy}
                className="opacity-70 group-hover/episode:opacity-100"
              />
            }
          >
            <EllipsisVertical />
          </MenuTrigger>
          <MenuPopup align="end" className="w-60">
            <MenuItem onClick={() => onMark(!watched)}>
              {watched ? "Mark unwatched" : "Mark watched"}
            </MenuItem>
            {earlier !== undefined && (
              <MenuItem onClick={() => onMarkEarlier(!earlier)}>
                {earlier ? "Mark earlier episodes unwatched" : "Mark earlier episodes watched"}
              </MenuItem>
            )}
          </MenuPopup>
        </Menu>
      )}
    </div>
  );
  if (!aired) return row;

  const through = menu.through(episode);
  return (
    <ContextMenu>
      <ContextMenuTrigger ref={trigger} className="contents">
        {row}
      </ContextMenuTrigger>
      <ContextMenuPopup
        className="material-pop w-64"
        finalFocus={() =>
          trigger.current?.querySelector<HTMLElement>("[data-episode-index]") ?? true
        }
      >
        <ContextMenuItem onClick={onPlay}>
          {entry ? <RotateCcw aria-hidden /> : <Play aria-hidden className="fill-current" />}
          {entry ? "Resume" : "Play"}
        </ContextMenuItem>
        {entry && (
          <ContextMenuItem onClick={() => menu.onPlayFromStart(episode)}>
            <Play aria-hidden className="fill-current" />
            Play from start
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem disabled={busy} onClick={() => onMark(!watched)}>
          {watched ? <EyeOff aria-hidden /> : <Eye aria-hidden />}
          {watched ? "Mark unwatched" : "Mark watched"}
        </ContextMenuItem>
        {through !== undefined && (
          <ContextMenuItem disabled={busy} onClick={() => menu.onMarkThrough(episode, !through)}>
            <Check aria-hidden />
            {through ? "Mark all up to here unwatched" : "Mark all up to here watched"}
          </ContextMenuItem>
        )}
        <ContextMenuItem disabled={busy} onClick={() => menu.onMarkSeason(!menu.seasonWatched)}>
          <Check aria-hidden />
          {menu.seasonWatched ? "Mark season unwatched" : "Mark season watched"}
        </ContextMenuItem>
        {entry && (
          <>
            <ContextMenuSeparator />
            <ContextMenuItem onClick={() => menu.onClearProgress(episode)}>
              <X aria-hidden />
              Clear progress
            </ContextMenuItem>
          </>
        )}
      </ContextMenuPopup>
    </ContextMenu>
  );
}
