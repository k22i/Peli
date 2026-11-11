import { defaultRangeExtractor, useVirtualizer, type Range } from "@tanstack/react-virtual";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type Key,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import {
  RovingContext,
  RovingIndexContext,
  prefersReducedMotion,
  useRovingFocus,
  withIndex,
} from "@/components/media/roving";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

export type CardShape = "poster" | "landscape";

// A row's link at the end of its heading ("See all", "Browse all"): a quiet
// capsule that brightens on hover.
export const rowLinkClassName =
  "inline-flex h-7 items-center gap-0.5 rounded-full ps-3 pe-2 text-small font-[590] text-muted-foreground outline-none transition-colors duration-(--duration-fast) hover:bg-foreground/8 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-3.5";

// The paging edges cover the art only, not the caption under it: from the
// scroller's top padding, as tall as a card's art (posters are 2:3, stills
// 16:9).
const artEdge: Record<CardShape, { top: string; height: string }> = {
  poster: { top: "0.75rem", height: "calc(var(--container-poster) * 3 / 2)" },
  landscape: { top: "0.75rem", height: "calc(var(--container-landscape) * 9 / 16)" },
};

// --container-poster and --container-landscape in index.css (a test keeps
// them in step), and the row's 16px gap. Cards are fixed widths, so these are
// exact and cards aren't measured.
export const cardRem: Record<CardShape, number> = { poster: 11.5, landscape: 20 };
const gapPx = 16;

export const remToPx = (rem: number) =>
  rem * (Number.parseFloat(getComputedStyle(document.documentElement).fontSize) || 16);

const px = (value: string) => Number.parseFloat(value) || 0;

const nextIndex: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => Math.min(index + 1, count - 1),
  ArrowLeft: (index) => Math.max(index - 1, 0),
  Home: () => 0,
  End: (_, count) => count - 1,
};

type RowHandle = { element: HTMLElement | null; focusNearest: (x: number) => void };

const RowGroupContext = createContext<Set<RowHandle> | null>(null);

// Rows stacked on a page (Home). Inside a group, ↑ and ↓ move focus to the
// card in the row above or below that's nearest the focused one.
export function RowGroup({ children }: { children: ReactNode }) {
  const [rows] = useState(() => new Set<RowHandle>());
  return <RowGroupContext.Provider value={rows}>{children}</RowGroupContext.Provider>;
}

function adjacentRow(rows: Set<RowHandle>, row: RowHandle, step: 1 | -1) {
  const ordered = [...rows]
    .filter((handle) => handle.element?.isConnected)
    .toSorted((a, b) =>
      // oxlint-disable-next-line no-bitwise -- compareDocumentPosition is a bit mask
      a.element!.compareDocumentPosition(b.element!) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
    );
  return ordered[ordered.indexOf(row) + step];
}

// A titled, horizontally scrolling shelf of cards (posters, landscape cards).
// Snaps to cards, shows paging arrows on hover, and is a single Tab stop.
// Virtualized: only the cards near the viewport are mounted, so a 200-poster
// row keeps ~15 images decoded, not 200 (WebKit keeps every <img> in the DOM
// decoded, #41).
export function Row<T>({
  title,
  action,
  items,
  getKey,
  renderItem,
  card = "poster",
  className,
}: {
  // Text, or text with a muted byline (Search: "Movies · Cinemeta").
  title: ReactNode;
  action?: ReactNode;
  items: readonly T[];
  getKey: (item: T, index: number) => Key;
  renderItem: (item: T, index: number) => ReactNode;
  // The card each item renders, to size it before it's measured.
  card?: CardShape | ((item: T) => CardShape);
  className?: string;
}) {
  const headingId = useId();
  const scroller = useRef<HTMLDivElement>(null);
  const [gutter, setGutter] = useState(0);
  const [edges, setEdges] = useState({ start: true, end: true });
  const count = items.length;
  const { active, setActive, focusIndex } = useRovingFocus(scroller, count);

  // Items can arrive ahead of the active card (search results, #44): it
  // follows its key, so focus and the Tab stop stay on the same card and
  // it stays mounted.
  const [shown, setShown] = useState(items);
  if (shown !== items) {
    setShown(items);
    const previous = shown[active];
    if (previous !== undefined) {
      const key = getKey(previous, active);
      const index = items.findIndex((item, i) => getKey(item, i) === key);
      if (index >= 0 && index !== active) setActive(index);
    }
  }

  const shapeOf = (index: number) => (typeof card === "function" ? card(items[index]!) : card);

  // No React Compiler in this app: nothing here is memoized behind its back.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    horizontal: true,
    count,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => remToPx(cardRem[shapeOf(index)]),
    getItemKey: (index) => getKey(items[index]!, index),
    gap: gapPx,
    // The page gutter, so the first card lines up with the title.
    paddingStart: gutter,
    paddingEnd: gutter,
    overscan: 3,
    // Before the first measure: a window's width, not one card.
    initialRect: { width: window.innerWidth, height: 0 },
    rangeExtractor: useCallback(
      (range: Range) => withIndex(defaultRangeExtractor(range), active),
      [active],
    ),
  });

  const updateEdges = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    setEdges({
      start: element.scrollLeft <= 1,
      end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    const update = () => {
      // The gutter is a clamp() of the window width; computed, it's pixels.
      setGutter(px(getComputedStyle(element).scrollPaddingLeft));
      updateEdges();
    };
    update();
    // jsdom has no ResizeObserver.
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateEdges]);

  const totalSize = virtualizer.getTotalSize();
  useEffect(updateEdges, [updateEdges, totalSize]);

  const handle = useRef<RowHandle>({ element: null, focusNearest: () => {} });
  const group = useContext(RowGroupContext);
  useLayoutEffect(() => {
    handle.current.focusNearest = (x) => {
      const element = scroller.current;
      if (!element) return;
      const left = element.getBoundingClientRect().left - element.scrollLeft;
      let nearest = active;
      let distance = Number.POSITIVE_INFINITY;
      for (const item of virtualizer.getVirtualItems()) {
        const away = Math.abs(left + item.start + item.size / 2 - x);
        if (away < distance) [nearest, distance] = [item.index, away];
      }
      focusIndex(nearest);
    };
  });
  useEffect(() => {
    if (!group) return undefined;
    const row = handle.current;
    group.add(row);
    return () => {
      group.delete(row);
    };
  }, [group]);

  const roving = useMemo(
    () => ({
      active,
      setActive,
      onItemKeyDown: (index: number, event: KeyboardEvent<HTMLElement>) => {
        const move = nextIndex[event.key];
        if (move) {
          event.preventDefault();
          focusIndex(move(index, count));
          return;
        }
        const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
        if (!step || !group) return;
        const target = adjacentRow(group, handle.current, step);
        if (!target) return;
        event.preventDefault();
        const rect = event.currentTarget.getBoundingClientRect();
        target.focusNearest(rect.left + rect.width / 2);
      },
    }),
    [active, count, focusIndex, group, setActive],
  );

  const page = (direction: 1 | -1) => {
    const element = scroller.current;
    if (!element) return;
    element.scrollBy({
      left: direction * element.clientWidth * 0.85,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  return (
    <section
      ref={(element) => {
        handle.current.element = element;
      }}
      aria-labelledby={headingId}
      className={cn("group/row relative", className)}
    >
      <div className="flex items-center justify-between gap-4 px-page">
        <h2 id={headingId} className="type-row">
          {title}
        </h2>
        {action}
      </div>
      <div className="relative">
        <div
          ref={scroller}
          onScroll={updateEdges}
          data-slot="row-scroller"
          className="no-scrollbar snap-x snap-mandatory scroll-px-page overflow-x-auto overscroll-x-contain pt-3 pb-4"
        >
          <RovingContext.Provider value={roving}>
            {/* Every card in one grid cell, each pushed along by its offset:
                the row is as tall as its tallest card, and snapping sees each
                card where it's drawn. */}
            <ul className="grid" style={{ width: totalSize }}>
              {virtualizer.getVirtualItems().map((item) => (
                <li
                  key={item.key}
                  data-index={item.index}
                  data-item={item.index}
                  className="col-start-1 row-start-1 w-fit snap-start self-start"
                  style={{ marginInlineStart: item.start }}
                >
                  <RovingIndexContext.Provider value={item.index}>
                    {renderItem(items[item.index]!, item.index)}
                  </RovingIndexContext.Provider>
                </li>
              ))}
            </ul>
          </RovingContext.Provider>
        </div>
        {/* Mouse paging only: keyboard users have the arrow keys. */}
        <PageButton
          side="start"
          edge={artEdge[count > 0 ? shapeOf(0) : "poster"]}
          hidden={edges.start}
          onClick={() => page(-1)}
        />
        <PageButton
          side="end"
          edge={artEdge[count > 0 ? shapeOf(0) : "poster"]}
          hidden={edges.end}
          onClick={() => page(1)}
        />
      </div>
    </section>
  );
}

// A tall edge over the clipped end of the row: the canvas darkens towards
// it and a chevron shows on hover.
function PageButton({
  side,
  edge,
  hidden,
  onClick,
}: {
  side: "start" | "end";
  edge: { top: string; height: string };
  hidden: boolean;
  onClick: () => void;
}) {
  const Icon = side === "start" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden
      onClick={onClick}
      style={edge}
      className={cn(
        "absolute z-10 grid w-page min-w-12 place-items-center text-foreground opacity-0 transition-opacity duration-(--duration-base) ease-out-soft group-hover/row:opacity-100 [&_svg]:size-7 [&_svg]:drop-shadow-md [&_svg]:transition-transform [&_svg]:duration-(--duration-fast) hover:[&_svg]:scale-115",
        side === "start"
          ? "start-0 bg-linear-to-r from-background/90 via-background/50 to-transparent"
          : "end-0 bg-linear-to-l from-background/90 via-background/50 to-transparent",
        hidden && "pointer-events-none group-hover/row:opacity-0",
      )}
    >
      <Icon strokeWidth={2.5} />
    </button>
  );
}

export function RowSkeleton({ count = 8, card = "poster" }: { count?: number; card?: CardShape }) {
  return (
    <div aria-hidden className="flex flex-col">
      <Skeleton className="mx-page my-1 h-4 w-36 rounded-full" />
      <div className="flex gap-4 overflow-hidden px-page pt-3 pb-4">
        {Array.from({ length: count }, (_, index) => (
          <Skeleton
            key={index}
            className={cn(
              "shrink-0 rounded-card",
              card === "poster" ? "aspect-[2/3] w-poster" : "aspect-video w-landscape",
            )}
          />
        ))}
      </div>
    </div>
  );
}
