// Pull to refresh, on iOS (#135): pulling the content pane down past its top
// shows a spinner under the header; letting go past `triggerPt` refreshes
// the page. The pane (#content) is an overflow div, whose own rubber band
// WebKit draws; the pull's distance is worked out from the finger with the
// same kind of damping, so the threshold doesn't depend on WebKit's numbers.
// Pure rules here; components/shell/pull-to-refresh.tsx feeds them touches.

// Letting go past this pull (in points, after damping) refreshes.
export const triggerPt = 64;
// The spinner's size, in points.
export const spinnerPt = 28;
// How far the finger moves before the pan counts as down or not.
const lockPt = 8;
// Never wait on a refresh longer than this before settling.
export const refreshTimeoutMs = 10_000;

export type Pull =
  | { phase: "idle" }
  // Touched while the pane was at its top; not yet clearly a pull down.
  | { phase: "pending"; startX: number; startY: number }
  | { phase: "pulling"; startY: number; distance: number; armed: boolean };

export const idlePull: Pull = { phase: "idle" };

// UIScrollView-like damping: the page moves less than the finger, more so
// the further it goes.
export function rubberBand(finger: number, dimension = 800): number {
  if (finger <= 0) return 0;
  const c = 0.55;
  return (1 - 1 / ((finger * c) / dimension + 1)) * dimension;
}

// A touch may start a pull only with the pane scrolled to its very top, on a
// page that refreshes, while nothing is refreshing already.
export function startPull(x: number, y: number, atTop: boolean, allowed: boolean): Pull {
  if (!allowed || !atTop) return idlePull;
  return { phase: "pending", startX: x, startY: y };
}

// One move of the finger. `armed` turns on as the pull passes the threshold
// (`crossed` is true on that move only, for the haptic) and off again if the
// finger goes back up.
export function movePull(state: Pull, x: number, y: number): { state: Pull; crossed: boolean } {
  if (state.phase === "idle") return { state, crossed: false };
  if (state.phase === "pending") {
    const dx = x - state.startX;
    const dy = y - state.startY;
    if (Math.hypot(dx, dy) < lockPt) return { state, crossed: false };
    // Up, or more sideways than down (a rail): not a pull.
    if (dy <= Math.abs(dx)) return { state: idlePull, crossed: false };
    return movePull({ phase: "pulling", startY: state.startY, distance: 0, armed: false }, x, y);
  }
  const distance = rubberBand(y - state.startY);
  const armed = distance >= triggerPt;
  return {
    state: { phase: "pulling", startY: state.startY, distance, armed },
    crossed: armed && !state.armed,
  };
}

// Letting go: refresh if the pull was past the threshold.
export function endPull(state: Pull): "refresh" | "none" {
  return state.phase === "pulling" && state.armed ? "refresh" : "none";
}

// How far along the threshold the pull is, 0–1, for the spinner's fade and
// turn while pulling.
export function pullProgress(state: Pull): number {
  if (state.phase !== "pulling") return 0;
  return Math.min(1, state.distance / triggerPt);
}
