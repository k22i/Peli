import { History } from "lucide-react";
import { useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { revealPx, slopPx, swipeEnd, swipeOffset } from "@/lib/swipe-row";

// Recent searches on the phone (#137): an inset list under the field, newest
// first, "Clear" at the header's end, a swipe left on a row for its Delete
// button (or a long swipe to delete it outright), a tap to search it again.
export function RecentList({
  list,
  onPick,
  onRemove,
  onClear,
}: {
  list: readonly string[];
  onPick: (term: string) => void;
  onRemove: (term: string) => void;
  onClear: () => void;
}) {
  // One row open at a time, as in iOS.
  const [open, setOpen] = useState<string>();
  if (list.length === 0) return null;
  return (
    <section aria-labelledby="recent-searches" className="flex flex-col gap-2 px-page">
      <div className="flex items-center justify-between gap-4 ps-1">
        <h2 id="recent-searches" className="text-[1.25rem] font-[650] tracking-[-0.01em]">
          Recent searches
        </h2>
        <Button variant="ghost" size="sm" className="-me-2" onClick={onClear}>
          Clear
        </Button>
      </div>
      <ul className="flex flex-col divide-y divide-border overflow-hidden rounded-xl bg-card hairline">
        {list.map((term) => (
          <SwipeRow
            key={term}
            term={term}
            open={open === term}
            onOpen={(next) => setOpen(next ? term : undefined)}
            onPick={onPick}
            onRemove={onRemove}
          />
        ))}
      </ul>
    </section>
  );
}

function SwipeRow({
  term,
  open,
  onOpen,
  onPick,
  onRemove,
}: {
  term: string;
  open: boolean;
  onOpen: (open: boolean) => void;
  onPick: (term: string) => void;
  onRemove: (term: string) => void;
}) {
  const row = useRef<HTMLLIElement>(null);
  const gesture = useRef<{
    x: number;
    t: number;
    from: number;
    swiping: boolean;
    velocity: number;
  }>(null);
  const [drag, setDrag] = useState<number>();
  const offset = drag ?? (open ? -revealPx : 0);
  const width = () => row.current?.offsetWidth ?? 320;
  // The click that ends a swipe isn't a tap on the row.
  const swiped = useRef(false);

  return (
    <li ref={row} className="relative overflow-hidden">
      <button
        type="button"
        aria-label={`Delete ${term}`}
        tabIndex={open ? 0 : -1}
        className="absolute inset-y-0 end-0 flex w-20 items-center justify-center bg-destructive text-[15px] font-[590] text-white outline-none"
        style={{ width: Math.max(revealPx, -offset) }}
        onClick={() => onRemove(term)}
      >
        Delete
      </button>
      <button
        type="button"
        className="relative flex min-h-11 w-full touch-pan-y items-center gap-3 bg-card px-4 text-start text-[17px] outline-none select-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        style={{
          transform: `translateX(${offset}px)`,
          transition:
            drag === undefined ? "transform 0.28s var(--ease-out-soft, ease-out)" : "none",
        }}
        onClick={() => {
          if (swiped.current) {
            swiped.current = false;
            return;
          }
          if (open) onOpen(false);
          else onPick(term);
        }}
        onPointerDown={(event) => {
          swiped.current = false;
          if (event.pointerType === "mouse") return;
          gesture.current = {
            x: event.clientX,
            t: event.timeStamp,
            from: open ? -revealPx : 0,
            swiping: false,
            velocity: 0,
          };
        }}
        onPointerMove={(event) => {
          const g = gesture.current;
          if (!g) return;
          const dx = event.clientX - g.x;
          if (!g.swiping) {
            if (Math.abs(dx) < slopPx) return;
            g.swiping = true;
            event.currentTarget.setPointerCapture(event.pointerId);
          }
          const next = swipeOffset(g.from, dx, width());
          const dt = Math.max(1, event.timeStamp - g.t);
          g.velocity = ((event.clientX - g.x) / dt) * 1000;
          setDrag(next);
        }}
        onPointerUp={() => {
          const g = gesture.current;
          gesture.current = null;
          if (!g?.swiping || drag === undefined) return;
          swiped.current = true;
          const end = swipeEnd(drag, g.velocity, width());
          setDrag(undefined);
          if (end === "delete") onRemove(term);
          else onOpen(end === "open");
        }}
        onPointerCancel={() => {
          gesture.current = null;
          setDrag(undefined);
        }}
      >
        <History aria-hidden className="size-5 shrink-0 text-muted-foreground" />
        <span className="truncate">{term}</span>
      </button>
    </li>
  );
}
