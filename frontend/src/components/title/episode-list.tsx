import { useVirtualizer } from "@tanstack/react-virtual";
import { Check, EllipsisVertical } from "lucide-react";
import { useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";

import { Artwork } from "@/components/media/artwork";
import { WatchProgress } from "@/components/media/cards";
import { scrollParent } from "@/components/media/poster-grid";
import { prefersReducedMotion } from "@/components/media/roving";
import { Button } from "@/components/ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "@/components/ui/menu";
import { episodeCode, isAired, type Episode, type TitleState } from "@/lib/title";
import { cn } from "@/lib/utils";

// A row's height before it's measured: a 16:9 still 14rem wide, plus padding.
const rowPx = 144;
const gapPx = 8;

const date = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

// One season's episodes, scrolled with the page and virtualized, since an
// anime can list a thousand in one season. Each row plays its episode and
// has a menu to mark it, or every episode before it. ↑ and ↓ move between
// rows. Unaired episodes are dimmed and can't be played or marked.
export function EpisodeList({
  label,
  episodes,
  state,
  busy,
  onPlay,
  onMark,
  onMarkEarlier,
  earlier,
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
}) {
  const list = useRef<HTMLOListElement>(null);
  const [scroller, setScroller] = useState<HTMLElement | null>(null);
  const [top, setTop] = useState(0);

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
    estimateSize: () => rowPx,
    // Nothing laid out (jsdom, a hidden page): keep the estimate.
    measureElement: (element) => element.getBoundingClientRect().height || rowPx,
    gap: gapPx,
    scrollMargin: top,
    overscan: 4,
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
      className="relative px-gutter"
      style={{ height: virtualizer.getTotalSize() }}
    >
      {virtualizer.getVirtualItems().map((item) => {
        const episode = episodes[item.index]!;
        return (
          <li
            key={episode.id}
            ref={virtualizer.measureElement}
            data-index={item.index}
            className="absolute inset-x-gutter top-0"
            style={{ transform: `translateY(${item.start - top}px)` }}
          >
            <EpisodeRow
              index={item.index}
              episode={episode}
              state={state}
              busy={busy}
              earlier={earlier(episode)}
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
  onPlay: () => void;
  onMark: (watched: boolean) => void;
  onMarkEarlier: (watched: boolean) => void;
  onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
}) {
  const aired = isAired(episode);
  const watched = state.watched(episode);
  const entry = state.progress(episode);
  const code = episodeCode(episode);
  const title = episode.title || `Episode ${episode.episode}`;
  const released = episode.released ? Date.parse(episode.released) : Number.NaN;
  const runtime = typeof episode["runtime"] === "string" ? episode["runtime"] : undefined;
  const line = [
    `E${episode.episode}`,
    Number.isNaN(released) ? undefined : `${aired ? "" : "Airs "}${date.format(released)}`,
    runtime,
  ].filter(Boolean);

  return (
    <div
      className={cn(
        "group/episode flex items-start gap-2 rounded-xl p-2 transition-colors hover:bg-accent/60",
        !aired && "opacity-55",
      )}
    >
      <button
        type="button"
        data-episode-index={index}
        disabled={!aired}
        aria-label={`${code}: ${title}${watched ? ", watched" : entry ? ", in progress" : ""}`}
        onClick={onPlay}
        onKeyDown={onKeyDown}
        className="flex min-w-0 flex-1 cursor-pointer items-start gap-4 rounded-lg text-start outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-default"
      >
        <span className="relative aspect-video w-112 shrink-0 overflow-hidden rounded-lg shadow-card">
          <Artwork src={episode.thumbnail} use="landscape" title={title} />
          {entry && <WatchProgress value={entry.position / entry.duration} />}
          {watched && (
            <span className="dark absolute end-2 top-2 grid size-6 place-items-center rounded-full bg-black/60 text-brand backdrop-blur-sm">
              <Check className="size-4" aria-hidden />
            </span>
          )}
        </span>
        <span className="flex min-w-0 flex-col gap-1 py-1">
          <span className="font-mono text-meta text-muted-foreground">{line.join(" · ")}</span>
          <span className="font-medium text-foreground">{title}</span>
          {episode.overview && (
            <span className="line-clamp-2 text-sm text-pretty text-muted-foreground">
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
                className="mt-1 opacity-70 group-hover/episode:opacity-100"
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
}
