import { Service as Haptics } from "@bindings/haptics";

import { isIOS } from "@/lib/platform";

// Taptic feedback on iOS (#135), through internal/haptics (UIKit's impact,
// selection and notification generators). A no-op everywhere else, and when
// the user has turned System Haptics off (UIKit checks).
//
// Call it where the action happens (the click, the toggle, the pull passing
// its threshold), never in an effect, so a re-render can't tap twice. The
// moments, after the ticket's table:
//   light      a long press opens a menu (#134); a Switch toggles; mark
//              watched or unwatched; add to or remove from the Library;
//              brightness or volume reaches a bound, a double-tap skip (#131)
//   medium     pull to refresh passes its threshold
//   selection  a tab, chip, segmented switch or season changes
//   error      an error toast, a wrong PIN
//   success    sign-in done, a device paired (#133)
export type HapticKind =
  | "light"
  | "medium"
  | "heavy"
  | "selection"
  | "success"
  | "warning"
  | "error";

// Chips scroll by under the finger: one selection tick per 50 ms at most.
export const selectionGapMs = 50;

let lastSelection = Number.NEGATIVE_INFINITY;

// Whether a selection tick at `now` comes too soon after the last one.
export function throttled(kind: HapticKind, now: number, last: number): boolean {
  return kind === "selection" && now - last < selectionGapMs;
}

export function haptic(kind: HapticKind): void {
  if (!isIOS()) return;
  const now = performance.now();
  if (throttled(kind, now, lastSelection)) return;
  if (kind === "selection") lastSelection = now;
  Haptics.Impact(kind).catch(() => {});
}
