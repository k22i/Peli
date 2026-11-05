import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type RefObject,
} from "react";

// Roving focus for rows and grids: the whole collection is one Tab stop, and
// the arrow keys move between its cards. They're virtualized, so a card can be
// off-screen and not mounted: focus goes by index, and the collection keeps the
// active card mounted wherever it is (see `withIndex`).
type Roving = {
  active: number;
  setActive: (index: number) => void;
  onItemKeyDown: (index: number, event: KeyboardEvent<HTMLElement>) => void;
};

export const RovingContext = createContext<Roving | null>(null);
export const RovingIndexContext = createContext(-1);

export const prefersReducedMotion = () =>
  window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Props for a card inside a Row or PosterGrid. Outside one, cards are
// ordinary Tab stops.
export function useRovingItem() {
  const roving = useContext(RovingContext);
  const index = useContext(RovingIndexContext);
  if (!roving || index < 0) return {};

  return {
    "data-row-item": "",
    tabIndex: index === roving.active ? 0 : -1,
    onFocus: () => roving.setActive(index),
    onKeyDown: (event: KeyboardEvent<HTMLElement>) => roving.onItemKeyDown(index, event),
  };
}

// How far down a card must stay from its scroll container's top edge to clear
// a sticky page header (Browse, Search and Library's, the title page's
// Episodes): the lowest such header's bottom edge. Zero when there is none.
export function stickyInset(from: HTMLElement): number {
  let scroller: HTMLElement | null = from.parentElement;
  while (scroller && !/auto|scroll|overlay/.test(getComputedStyle(scroller).overflowY)) {
    scroller = scroller.parentElement;
  }
  if (!scroller) return 0;
  const top = scroller.getBoundingClientRect().top;
  let bottom = top;
  for (const header of scroller.querySelectorAll<HTMLElement>("header")) {
    if (getComputedStyle(header).position === "sticky") {
      bottom = Math.max(bottom, header.getBoundingClientRect().bottom);
    }
  }
  return bottom - top;
}

// Scrolls a card into view on both axes, so the page follows a row the focus
// moved into. A card above the fold stops below the sticky header, not under
// it.
function scrollIntoView(item: HTMLElement) {
  item.style.scrollMarginTop = `${stickyInset(item) + 8}px`;
  item.scrollIntoView?.({
    block: "nearest",
    inline: "nearest",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
}

// The active index, and `focusIndex`, which makes an item active, waits for it
// to mount, then focuses it and scrolls it into view with `scrollTo`. Items
// carry `data-item={index}`.
export function useRovingFocus(
  container: RefObject<HTMLElement | null>,
  count: number,
  scrollTo: (item: HTMLElement, index: number) => void = scrollIntoView,
) {
  const [active, setActive] = useState(0);
  const [request, setRequest] = useState<{ index: number } | null>(null);
  const scroll = useRef(scrollTo);
  useLayoutEffect(() => {
    scroll.current = scrollTo;
  });

  useLayoutEffect(() => {
    if (!request) return;
    const item = container.current?.querySelector<HTMLElement>(
      `[data-item="${request.index}"] [data-row-item]`,
    );
    if (!item) return;
    item.focus({ preventScroll: true });
    scroll.current(item, request.index);
  }, [container, request]);

  const focusIndex = useCallback((index: number) => {
    setActive(index);
    setRequest({ index });
  }, []);

  return { active: Math.max(Math.min(active, count - 1), 0), setActive, focusIndex };
}

// The virtualizer's indexes, plus the active one: unmounting the focused card
// would drop focus to the page, and the row's Tab stop must always exist.
export function withIndex(indexes: number[], index: number): number[] {
  if (index < 0 || indexes.includes(index)) return indexes;
  return [...indexes, index].toSorted((a, b) => a - b);
}
