import { Eye, EyeOff, Trash2 } from "lucide-react";

import { Button } from "@/components/ui/button";

// The bar that rises over the Library while titles are selected: how many,
// what can be done to them all, and Done. It floats on the pop-up material
// (the same as menus), at the foot of the window, clear of the sidebar.
export function SelectionBar({
  count,
  onMarkWatched,
  onMarkUnwatched,
  onRemove,
  onDone,
}: {
  count: number;
  onMarkWatched: () => void;
  onMarkUnwatched: () => void;
  onRemove: () => void;
  onDone: () => void;
}) {
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-20 flex justify-center px-page">
      <div
        role="toolbar"
        aria-label="Selection"
        className="material-pop pointer-events-auto flex flex-wrap items-center gap-1 rounded-full p-1.5 ps-5"
      >
        <output className="me-2 type-item tnum">{count} selected</output>
        <Button variant="ghost" onClick={onMarkWatched}>
          <Eye />
          Mark watched
        </Button>
        <Button variant="ghost" onClick={onMarkUnwatched}>
          <EyeOff />
          Mark unwatched
        </Button>
        <Button variant="ghost" onClick={onRemove}>
          <Trash2 />
          Remove from Library
        </Button>
        <Button variant="secondary" onClick={onDone}>
          Done
        </Button>
      </div>
    </div>
  );
}
