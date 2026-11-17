import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { useCallback, useEffect, useReducer, useRef, type ReactNode } from "react";

import { idleDrag, sheetDrag, springEasing } from "@/lib/sheet-drag";
import { markSheetOpen } from "@/lib/sheets";
import { cn } from "@/lib/utils";

// The spring a let-go sheet returns to rest with (no animation library, #110).
const spring = `transform 0.5s ${springEasing()}`;
const reducedMotion = () =>
  typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches;

// A sheet from the bottom edge on the compact iOS shell (#134), for menus and
// pickers in place of popovers: the pop material, 28 pt top corners and a
// grabber, full width with the safe areas padded, at most 70 % of the screen
// tall (the rows scroll beyond that). It closes on a drag down past a
// quarter of its height or a flick, a tap on the dimmed backdrop, or Escape;
// otherwise a drag springs back. With Reduce Motion it fades instead of
// sliding. A Base UI dialog underneath: role="dialog", modal, focus moved
// in and handed back (`finalFocus`, the trigger by default).
export function BottomSheet({
  open,
  onOpenChange,
  label,
  labelledBy,
  header,
  initialFocus,
  finalFocus,
  children,
  className,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  // The sheet's accessible name: `label`, or the id of an element naming it.
  label?: string | undefined;
  labelledBy?: string | undefined;
  // Above the rows, under the grabber; dragging it moves the sheet too.
  header?: ReactNode;
  initialFocus?: DialogPrimitive.Popup.Props["initialFocus"];
  finalFocus?: DialogPrimitive.Popup.Props["finalFocus"];
  children: ReactNode;
  className?: string;
}) {
  const [drag, dispatch] = useReducer(sheetDrag, idleDrag);
  // The last drag's end, so the click that follows it doesn't choose a row.
  const draggedAt = useRef(0);

  // The shell hides its tab bar while a sheet is open (#129).
  useEffect(() => (open ? markSheetOpen() : undefined), [open]);
  // A fresh sheet starts at rest.
  useEffect(() => {
    if (open) dispatch({ type: "reset" });
  }, [open]);
  const change = useRef(onOpenChange);
  useEffect(() => {
    change.current = onOpenChange;
  });
  useEffect(() => {
    if (drag.phase === "closing") change.current(false);
    if (drag.phase === "settling") {
      const timer = setTimeout(() => dispatch({ type: "settled" }), 500);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [drag.phase]);

  const end = useCallback(() => {
    draggedAt.current = Date.now();
    dispatch({ type: "end" });
  }, []);

  // A pull down from the rows, once they're scrolled to the top. Touch
  // events, not pointer events: WebKit cancels the pointer as soon as the
  // list starts to scroll, and only a non-passive touchmove can stop that.
  const rows = useCallback(
    (element: HTMLDivElement | null) => {
      if (!element) return () => {};
      let armed: number | undefined;
      let dragging = false;
      const start = (event: TouchEvent) => {
        dragging = false;
        armed = element.scrollTop <= 0 ? event.touches[0]?.clientY : undefined;
      };
      const move = (event: TouchEvent) => {
        const touch = event.touches[0];
        if (armed === undefined || !touch) return;
        const dy = touch.clientY - armed;
        if (!dragging) {
          if (dy < 0 || element.scrollTop > 0) {
            armed = undefined;
            return;
          }
          if (dy < 6) return;
          dragging = true;
          dispatch({ type: "start", y: armed, t: event.timeStamp, height: sheetHeight(element) });
        }
        event.preventDefault();
        dispatch({ type: "move", y: touch.clientY, t: event.timeStamp });
      };
      const stop = () => {
        if (dragging) end();
        dragging = false;
        armed = undefined;
      };
      element.addEventListener("touchstart", start, { passive: true });
      element.addEventListener("touchmove", move, { passive: false });
      element.addEventListener("touchend", stop);
      element.addEventListener("touchcancel", stop);
      return () => {
        element.removeEventListener("touchstart", start);
        element.removeEventListener("touchmove", move);
        element.removeEventListener("touchend", stop);
        element.removeEventListener("touchcancel", stop);
      };
    },
    [end],
  );

  const dragging = drag.phase === "dragging";
  const moved = drag.phase === "dragging" || drag.phase === "settling";
  const fade = moved ? Math.min(1, Math.max(0, 1 - drag.offset / (drag.height || 400))) : undefined;

  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Backdrop
          data-slot="bottom-sheet-backdrop"
          className="fixed inset-0 z-50 bg-black/40 transition-opacity duration-300 data-ending-style:opacity-0 data-starting-style:opacity-0"
          style={fade === undefined ? undefined : { opacity: fade }}
        />
        <DialogPrimitive.Popup
          aria-modal="true"
          aria-label={label}
          aria-labelledby={labelledBy}
          initialFocus={initialFocus}
          finalFocus={finalFocus}
          data-slot="bottom-sheet"
          data-dragging={dragging || undefined}
          onClickCapture={(event) => {
            // A drag that ended on a row isn't a tap on it.
            if (Date.now() - draggedAt.current < 350) {
              event.preventDefault();
              event.stopPropagation();
            }
          }}
          className={cn(
            "material-pop fixed inset-x-0 bottom-0 z-50 flex max-h-[70dvh] flex-col rounded-t-[28px] rounded-b-none border-x-0 border-b-0 text-foreground outline-none",
            "ps-[env(safe-area-inset-left)] pe-[env(safe-area-inset-right)] pb-[env(safe-area-inset-bottom)]",
            "transition-[translate,opacity] duration-[420ms] ease-[cubic-bezier(0.32,0.72,0,1)]",
            "data-ending-style:translate-y-full data-starting-style:translate-y-full",
            "motion-reduce:duration-200 motion-reduce:data-ending-style:translate-y-0 motion-reduce:data-ending-style:opacity-0 motion-reduce:data-starting-style:translate-y-0 motion-reduce:data-starting-style:opacity-0",
            className,
          )}
          style={
            moved
              ? {
                  transform: `translateY(${drag.offset}px)`,
                  transition: dragging || reducedMotion() ? "none" : spring,
                }
              : drag.phase === "closing"
                ? { transform: `translateY(${drag.offset}px)` }
                : undefined
          }
        >
          <div
            data-slot="bottom-sheet-handle"
            className="shrink-0 touch-none select-none"
            onPointerDown={(event) => {
              if (event.button !== 0) return;
              event.currentTarget.setPointerCapture?.(event.pointerId);
              dispatch({
                type: "start",
                y: event.clientY,
                t: event.timeStamp,
                height: sheetHeight(event.currentTarget),
              });
            }}
            onPointerMove={(event) => {
              if (drag.phase !== "dragging") return;
              dispatch({ type: "move", y: event.clientY, t: event.timeStamp });
            }}
            onPointerUp={() => {
              if (drag.phase === "dragging") end();
            }}
            onPointerCancel={() => dispatch({ type: "cancel" })}
          >
            <div className="flex justify-center pt-[7px] pb-2">
              <span aria-hidden className="h-[5px] w-9 rounded-full bg-foreground/25" />
            </div>
            {header}
          </div>
          <div
            ref={rows}
            data-slot="bottom-sheet-rows"
            className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-4 pt-1 pb-4"
          >
            {children}
          </div>
        </DialogPrimitive.Popup>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

// The height of the sheet an element is in.
function sheetHeight(element: HTMLElement): number {
  return element.closest<HTMLElement>('[data-slot="bottom-sheet"]')?.offsetHeight ?? 0;
}

// The title line some sheets show under the grabber (a Select's name).
export function BottomSheetTitle({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <h2 id={id} className="px-5 pb-2 text-center text-[17px] font-[620] tracking-[-0.01em]">
      {children}
    </h2>
  );
}
