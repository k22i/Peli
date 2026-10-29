import {
  defaultRangeExtractor,
  useVirtualizer,
  type Range,
  type Virtualizer,
} from "@tanstack/react-virtual";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type Key,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { cardRem, remToPx } from "@/components/media/row";
import {
  RovingContext,
  RovingIndexContext,
  prefersReducedMotion,
  useRovingFocus,
  withIndex,
} from "@/components/media/roving";
import { cn } from "@/lib/utils";

const columnGapPx = 16;
const rowGapPx = 28;
// How many rows from the end onEndReached fires: about a screen ahead.
const endRows = 3;
// A card's title and meta lines under the art, until rows are measured.
const captionPx = 48;

const px = (value: string) => Number.parseFloat(value) || 0;

// The page's scroll container: #content in the app shell, <main> on narrow
// windows.
function scrollParent(element: HTMLElement): HTMLElement {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/auto|scroll|overlay/.test(getComputedStyle(node).overflowY)) return node;
  }
  return document.documentElement;
}

// A row's height is its tallest card's: cards without a meta line are shorter.
function measureRow(
  element: Element,
  _entry: ResizeObserverEntry | undefined,
  instance: Virtualizer<HTMLElement, Element>,
) {
  const row = element.getAttribute("data-index");
  let height = 0;
  for (const cell of element.parentElement?.querySelectorAll<HTMLElement>(
    `:scope > [data-index="${row}"]`,
  ) ?? []) {
    height = Math.max(height, cell.offsetHeight);
  }
  // Nothing laid out (jsdom, a hidden page): keep the estimate.
  return height || instance.options.estimateSize(Number(row));
}

// Posters filling the page's width (browse, search, library), scrolled with
// the page. Virtualized by row: only the rows near the viewport are mounted.
// Columns are as many --container-poster widths as fit, then stretched to
// fill. One Tab stop; the arrow keys, Home and End move between cards.
// `onEndReached` asks for more when the last rows come near (infinite
// scroll, #43), and again whenever items arrive and the end is still near.
export function PosterGrid<T>({
  items,
  getKey,
  renderItem,
  onEndReached,
  label,
  className,
}: {
  items: readonly T[];
  getKey: (item: T, index: number) => Key;
  renderItem: (item: T, index: number) => ReactNode;
  onEndReached?: () => void;
  label?: string;
  className?: string;
}) {
  const list = useRef<HTMLUListElement>(null);
  const [scrollElement, setScrollElement] = useState<HTMLElement | null>(null);
  const [layout, setLayout] = useState(() => ({
    columns: 1,
    cardWidth: remToPx(cardRem.poster),
    top: 0,
  }));
  const { columns, cardWidth } = layout;
  const count = items.length;
  const rows = Math.ceil(count / columns);
  // A smooth scrollIntoView stops short on long jumps: rows measured on the
  // way move the target. The virtualizer's own scroll retargets as they do.
  const { active, setActive, focusIndex } = useRovingFocus(list, count, (_, index) => {
    virtualizer.scrollToIndex(Math.floor(index / columns), {
      align: "auto",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  });

  useLayoutEffect(() => {
    const element = list.current;
    if (!element) return undefined;
    const scroller = scrollParent(element);
    setScrollElement(scroller);
    const update = () => {
      const style = getComputedStyle(element);
      const width = element.clientWidth - px(style.paddingLeft) - px(style.paddingRight);
      const poster = remToPx(cardRem.poster);
      const fit = Math.max(Math.floor((width + columnGapPx) / (poster + columnGapPx)), 1);
      setLayout({
        columns: fit,
        cardWidth: width > 0 ? (width - columnGapPx * (fit - 1)) / fit : poster,
        top:
          element.getBoundingClientRect().top -
          scroller.getBoundingClientRect().top +
          scroller.scrollTop,
      });
    };
    update();
    // jsdom has no ResizeObserver.
    if (typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    // Content above the grid moving it down, too.
    if (scroller.firstElementChild) observer.observe(scroller.firstElementChild);
    return () => observer.disconnect();
  }, []);

  const activeRow = Math.floor(active / columns);
  // No React Compiler in this app: nothing here is memoized behind its back.
  // oxlint-disable-next-line react/incompatible-library
  const virtualizer = useVirtualizer({
    count: rows,
    getScrollElement: () => scrollElement,
    estimateSize: () => cardWidth * 1.5 + captionPx,
    measureElement: measureRow,
    gap: rowGapPx,
    scrollMargin: layout.top,
    overscan: 2,
    initialRect: { width: 0, height: window.innerHeight },
    rangeExtractor: useCallback(
      (range: Range) => withIndex(defaultRangeExtractor(range), activeRow),
      [activeRow],
    ),
  });

  const lastMounted = virtualizer.getVirtualItems().at(-1)?.index;
  const nearEnd = lastMounted !== undefined && lastMounted >= rows - 1 - endRows;
  useEffect(() => {
    if (nearEnd) onEndReached?.();
  }, [nearEnd, count, onEndReached]);

  const roving = useMemo(() => {
    const last = count - 1;
    const lastRow = Math.floor(last / columns);
    const moves: Record<string, (index: number) => number> = {
      ArrowRight: (index) => Math.min(index + 1, last),
      ArrowLeft: (index) => Math.max(index - 1, 0),
      // Down from the row above a short last row lands on its last card.
      ArrowDown: (index) =>
        Math.floor(index / columns) < lastRow ? Math.min(index + columns, last) : index,
      ArrowUp: (index) => (index >= columns ? index - columns : index),
      Home: () => 0,
      End: () => last,
    };
    return {
      active,
      setActive,
      onItemKeyDown: (index: number, event: KeyboardEvent<HTMLElement>) => {
        const move = moves[event.key];
        if (!move) return;
        event.preventDefault();
        focusIndex(move(index));
      },
    };
  }, [active, columns, count, focusIndex, setActive]);

  const margin = virtualizer.options.scrollMargin;
  return (
    <RovingContext.Provider value={roving}>
      <ul
        ref={list}
        aria-label={label}
        data-slot="poster-grid"
        className={cn("relative px-gutter", className)}
        style={
          {
            height: virtualizer.getTotalSize(),
            // Cards take the column's width.
            "--container-poster": `${cardWidth}px`,
          } as CSSProperties
        }
      >
        {virtualizer.getVirtualItems().flatMap((row) =>
          Array.from({ length: Math.min(columns, count - row.index * columns) }, (_, column) => {
            const index = row.index * columns + column;
            const item = items[index]!;
            return (
              <li
                key={getKey(item, index)}
                // One cell per row is observed; measureRow reads them all.
                ref={column === 0 ? virtualizer.measureElement : undefined}
                data-index={row.index}
                data-item={index}
                className="absolute top-0"
                style={{
                  insetInlineStart: `calc(var(--spacing-gutter) + ${column * (cardWidth + columnGapPx)}px)`,
                  transform: `translateY(${row.start - margin}px)`,
                }}
              >
                <RovingIndexContext.Provider value={index}>
                  {renderItem(item, index)}
                </RovingIndexContext.Provider>
              </li>
            );
          }),
        )}
      </ul>
    </RovingContext.Provider>
  );
}
