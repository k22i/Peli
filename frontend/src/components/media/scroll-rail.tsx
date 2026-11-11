import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FocusEvent,
  type ReactNode,
} from "react";

import { prefersReducedMotion } from "@/components/media/roving";
import { cn } from "@/lib/utils";

// A single line of items that scrolls sideways (#116): catalog chips, stream
// source pills. The first item lines up with the page text (the scroller's
// own padding), but items scroll out to the window edge, fading at an end
// that has more. Arrows (material-pop) appear on hover or focus; a mouse wheel
// scrolls it sideways while there is more that way; focus moving to an item
// brings it into view; `revealSelector` brings the selected one into view
// on mount.
export function ScrollRail({
  children,
  className,
  label,
  revealSelector,
}: {
  children: ReactNode;
  className?: string | undefined;
  // Names the scroll region when the children aren't a labelled group.
  label?: string | undefined;
  // For example `[data-pressed]`: the element to centre on mount.
  revealSelector?: string | undefined;
}) {
  const scroller = useRef<HTMLDivElement | null>(null);
  // Only these two flip while scrolling, so a frame of scrolling re-renders
  // nothing; the fades are CSS on the wrapper's data attributes.
  const [edges, setEdges] = useState({ atStart: true, atEnd: true });

  const measure = useCallback(() => {
    const element = scroller.current;
    if (!element) return;
    const left = Math.abs(element.scrollLeft);
    const next = {
      atStart: left <= 1,
      atEnd: left >= element.scrollWidth - element.clientWidth - 1,
    };
    setEdges((previous) =>
      previous.atStart === next.atStart && previous.atEnd === next.atEnd ? previous : next,
    );
  }, []);

  useEffect(() => {
    const element = scroller.current;
    if (!element) return undefined;
    let frame = 0;
    const onScroll = () => {
      if (!frame) {
        frame = requestAnimationFrame(() => {
          frame = 0;
          measure();
        });
      }
    };
    // A vertical wheel scrolls the rail while it can go that way; otherwise
    // the page keeps the gesture. Sideways (trackpad) movement is left alone.
    const onWheel = (event: WheelEvent) => {
      if (event.ctrlKey || event.deltaX !== 0 || event.deltaY === 0) return;
      const room = element.scrollWidth - element.clientWidth;
      if (room <= 1) return;
      const left = element.scrollLeft;
      if (event.deltaY > 0 ? left >= room - 1 : left <= 0) return;
      event.preventDefault();
      element.scrollLeft += event.deltaY;
    };
    measure();
    element.addEventListener("scroll", onScroll, { passive: true });
    element.addEventListener("wheel", onWheel, { passive: false });
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    observer?.observe(element);
    if (element.firstElementChild) observer?.observe(element.firstElementChild);
    return () => {
      cancelAnimationFrame(frame);
      element.removeEventListener("scroll", onScroll);
      element.removeEventListener("wheel", onWheel);
      observer?.disconnect();
    };
  }, [measure]);

  // The selected item, centred, without animation.
  useLayoutEffect(() => {
    if (!revealSelector) return;
    scroller.current
      ?.querySelector(revealSelector)
      ?.scrollIntoView?.({ inline: "center", block: "nearest", behavior: "auto" });
  }, [revealSelector]);

  const scrollBy = (direction: -1 | 1) =>
    scroller.current?.scrollBy?.({
      left: direction * scroller.current.clientWidth * 0.8,
      behavior: prefersReducedMotion() ? "auto" : "smooth",
    });

  return (
    <div
      data-slot="scroll-rail"
      data-at-start={edges.atStart || undefined}
      data-at-end={edges.atEnd || undefined}
      className={cn("group/rail relative", className)}
    >
      {!edges.atStart && <RailArrow side="start" onClick={() => scrollBy(-1)} />}
      <div
        ref={scroller}
        role={label ? "region" : undefined}
        aria-label={label}
        onFocus={followFocus}
        className="no-scrollbar rail-mask -my-1 flex gap-2 overflow-x-auto overscroll-x-contain scroll-px-(--spacing-page) px-page py-1"
      >
        {children}
      </div>
      {!edges.atEnd && <RailArrow side="end" onClick={() => scrollBy(1)} />}
    </div>
  );
}

// Focus moving to an item (roving arrow keys) brings it into view.
function followFocus(event: FocusEvent<HTMLDivElement>) {
  if (event.target === event.currentTarget) return;
  event.target.scrollIntoView?.({
    inline: "nearest",
    block: "nearest",
    behavior: prefersReducedMotion() ? "auto" : "smooth",
  });
}

function RailArrow({ side, onClick }: { side: "start" | "end"; onClick: () => void }) {
  const Icon = side === "start" ? ChevronLeft : ChevronRight;
  return (
    <button
      type="button"
      tabIndex={-1}
      aria-label={side === "start" ? "Scroll left" : "Scroll right"}
      onClick={onClick}
      className={cn(
        "absolute top-1/2 z-10 grid size-8 -translate-y-1/2 place-items-center rounded-full bg-popover text-foreground opacity-0 shadow-float transition-[opacity,scale] duration-(--duration-base) ease-out-soft group-focus-within/rail:opacity-100 group-hover/rail:opacity-100 motion-safe:active:scale-95 [&_svg]:size-4",
        side === "start" ? "start-2" : "end-2",
      )}
    >
      <Icon aria-hidden />
    </button>
  );
}
