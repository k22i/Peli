import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  Children,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

type RowState = {
  active: number;
  setActive: (index: number) => void;
  focusItem: (index: number) => void;
  count: number;
};

const RowContext = createContext<RowState | null>(null);
const RowIndexContext = createContext(-1);

const nextIndex: Record<string, (index: number, count: number) => number> = {
  ArrowRight: (index, count) => Math.min(index + 1, count - 1),
  ArrowLeft: (index) => Math.max(index - 1, 0),
  Home: () => 0,
  End: (_, count) => count - 1,
};

const prefersReducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Props for a card inside a Row: the row is one Tab stop and the arrow keys,
// Home and End move between its cards. Outside a Row, cards are ordinary
// Tab stops.
export function useRowItem() {
  const row = useContext(RowContext);
  const index = useContext(RowIndexContext);
  if (!row || index < 0) return {};

  return {
    "data-row-item": "",
    tabIndex: index === row.active ? 0 : -1,
    onFocus: () => row.setActive(index),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => {
      const move = nextIndex[event.key];
      if (!move) return;
      event.preventDefault();
      row.focusItem(move(index, row.count));
    },
  };
}

// A titled, horizontally scrolling shelf of cards (posters, landscape cards).
// Snaps to cards, shows paging arrows on hover, and is a single Tab stop.
export function Row({
  title,
  action,
  children,
  className,
}: {
  title: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  const list = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  const [edges, setEdges] = useState({ start: true, end: true });

  const updateEdges = useCallback(() => {
    const element = list.current;
    if (!element) return;
    setEdges({
      start: element.scrollLeft <= 1,
      end: element.scrollLeft + element.clientWidth >= element.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    const element = list.current;
    updateEdges();
    // jsdom has no ResizeObserver.
    if (!element || typeof ResizeObserver === "undefined") return undefined;
    const observer = new ResizeObserver(updateEdges);
    observer.observe(element);
    return () => observer.disconnect();
  }, [updateEdges]);

  const focusItem = useCallback((index: number) => {
    const item = list.current?.querySelectorAll<HTMLElement>("[data-row-item]")[index];
    if (!item) return;
    item.focus({ preventScroll: true });
    item.scrollIntoView?.({
      block: "nearest",
      inline: "nearest",
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  }, []);

  const page = (direction: 1 | -1) => {
    const element = list.current;
    if (!element) return;
    element.scrollBy({
      left: direction * element.clientWidth * 0.85,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });
  };

  const count = Children.count(children);
  const state = useMemo(
    () => ({ active: Math.min(active, count - 1), setActive, focusItem, count }),
    [active, count, focusItem],
  );

  return (
    <section aria-labelledby={headingId} className={cn("group/row relative", className)}>
      <div className="flex items-baseline justify-between gap-4 px-gutter pb-1">
        <h2 id={headingId} className="font-heading text-heading font-stretch-semi-expanded">
          {title}
        </h2>
        {action}
      </div>
      <div className="relative">
        <RowContext.Provider value={state}>
          <ul
            ref={list}
            onScroll={updateEdges}
            className="flex snap-x snap-mandatory scroll-px-gutter gap-4 overflow-x-auto overscroll-x-contain px-gutter pt-3 pb-5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
          >
            {Children.map(children, (item, index) => (
              <RowIndexContext.Provider value={index}>
                <li className="shrink-0 snap-start">{item}</li>
              </RowIndexContext.Provider>
            ))}
          </ul>
        </RowContext.Provider>
        {/* Mouse paging only: keyboard users have the arrow keys. */}
        <PageButton side="start" hidden={edges.start} onClick={() => page(-1)} />
        <PageButton side="end" hidden={edges.end} onClick={() => page(1)} />
      </div>
    </section>
  );
}

function PageButton({
  side,
  hidden,
  onClick,
}: {
  side: "start" | "end";
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
      className={cn(
        "glass absolute top-[calc(50%-1rem)] grid size-10 -translate-y-1/2 place-items-center rounded-full bg-popover text-popover-foreground opacity-0 transition-[opacity,scale] duration-(--duration-base) ease-smooth group-hover/row:opacity-100 hover:bg-popover motion-safe:active:scale-95 [&_svg]:size-5",
        side === "start" ? "start-3" : "end-3",
        hidden && "pointer-events-none group-hover/row:opacity-0",
      )}
    >
      <Icon />
    </button>
  );
}

export function RowSkeleton({
  count = 8,
  card = "poster",
}: {
  count?: number;
  card?: "poster" | "landscape";
}) {
  return (
    <div aria-hidden className="flex flex-col gap-3">
      <Skeleton className="mx-gutter h-5 w-40 rounded-md" />
      <div className="flex gap-4 overflow-hidden px-gutter pt-3 pb-5">
        {Array.from({ length: count }, (_, index) => (
          <Skeleton
            key={index}
            className={cn(
              "shrink-0 rounded-xl",
              card === "poster" ? "aspect-[2/3] w-poster" : "aspect-video w-landscape",
            )}
          />
        ))}
      </div>
    </div>
  );
}
