// Swipe from the left edge to go back, on iOS (#135). WKWebView's own
// back-forward gesture doesn't apply to the router's in-memory hash history,
// so the shell does it itself: a pan that starts within `edgePt` of the left
// edge, moving right, drags the page with the finger; letting go past
// `commitShare` of the width, or with a flick faster than `flickPtPerS`,
// goes back. Pure rules here; components/shell/use-edge-back.ts feeds them
// touches. #138 (iPad) can reuse them with a pointer.

// Where a swipe must start, in points from the left edge.
export const edgePt = 20;
// How far the finger moves before the pan counts as sideways or not.
export const lockPt = 10;
// The share of the width past which letting go goes back.
export const commitShare = 0.35;
// A rightward flick at least this fast goes back from anywhere.
export const flickPtPerS = 500;
// The velocity is measured over the last stretch of the pan.
const velocityWindowMs = 80;

export type EdgeSample = { x: number; t: number };

export type EdgeBack =
  | { phase: "idle" }
  // Started in the edge; not yet clearly sideways.
  | { phase: "pending"; startX: number; startY: number; samples: EdgeSample[] }
  // Dragging the page.
  | { phase: "dragging"; startX: number; samples: EdgeSample[] };

export const idleEdgeBack: EdgeBack = { phase: "idle" };

// Whether a touch at x may start a swipe back: in the edge, and the page
// can go back right now (history to go back to, not the player, not a focus
// screen, no sheet open; the caller works those out).
export function startEdgeBack(x: number, y: number, t: number, allowed: boolean): EdgeBack {
  if (!allowed || x > edgePt) return idleEdgeBack;
  return { phase: "pending", startX: x, startY: y, samples: [{ x, t }] };
}

function keep(samples: EdgeSample[], sample: EdgeSample): EdgeSample[] {
  return [...samples.filter((s) => sample.t - s.t <= velocityWindowMs), sample];
}

// One move of the finger. A pending pan that goes up, down or left more than
// it goes right is let go (the page scrolls as usual); one that goes right
// becomes a drag. `claim` is true from the move that starts the drag: the
// caller then stops the browser scrolling (preventDefault).
export function moveEdgeBack(
  state: EdgeBack,
  x: number,
  y: number,
  t: number,
): { state: EdgeBack; offset: number; claim: boolean } {
  if (state.phase === "idle") return { state, offset: 0, claim: false };
  if (state.phase === "pending") {
    const dx = x - state.startX;
    const dy = y - state.startY;
    if (Math.hypot(dx, dy) < lockPt) {
      return {
        state: { ...state, samples: keep(state.samples, { x, t }) },
        offset: 0,
        claim: false,
      };
    }
    if (dx <= Math.abs(dy)) return { state: idleEdgeBack, offset: 0, claim: false };
    return {
      state: { phase: "dragging", startX: state.startX, samples: keep(state.samples, { x, t }) },
      offset: Math.max(0, dx),
      claim: true,
    };
  }
  return {
    state: { ...state, samples: keep(state.samples, { x, t }) },
    offset: Math.max(0, x - state.startX),
    claim: true,
  };
}

// The finger's speed to the right, in points a second, over the last
// stretch of the pan.
export function edgeVelocity(samples: readonly EdgeSample[]): number {
  const first = samples[0];
  const last = samples.at(-1);
  if (!first || !last || last.t <= first.t) return 0;
  return ((last.x - first.x) / (last.t - first.t)) * 1000;
}

// What letting go does: "back" past the threshold or after a rightward flick,
// "cancel" (spring back) otherwise, "none" when no drag had started.
export function endEdgeBack(
  state: EdgeBack,
  offset: number,
  width: number,
): "back" | "cancel" | "none" {
  if (state.phase !== "dragging") return "none";
  if (offset > width * commitShare) return "back";
  return edgeVelocity(state.samples) > flickPtPerS ? "back" : "cancel";
}

// How dark the space behind the page is while it slides: 30 % at rest,
// clearing as the page leaves.
export function edgeDim(offset: number, width: number): number {
  if (width <= 0) return 0;
  return 0.3 * (1 - Math.min(1, Math.max(0, offset / width)));
}
