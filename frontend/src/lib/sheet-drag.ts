// The drag of a bottom sheet (#134): a finger pulls the sheet down, and on
// release it either closes or springs back. Pure, so the rules are tested
// without a browser; components/ui/bottom-sheet.tsx feeds it pointer and
// touch events.
//
// Distances are CSS px, which are UIKit points in the webview; times are ms.

export type SheetDrag = {
  phase: "idle" | "dragging" | "settling" | "closing";
  // Where the finger went down, and where it was last.
  startY: number;
  lastY: number;
  lastT: number;
  // How far the sheet is pulled down (negative: a little up, with resistance).
  offset: number;
  // Downward speed in px/s, smoothed over the last moves.
  velocity: number;
};

export type SheetDragAction =
  | { type: "start"; y: number; t: number }
  | { type: "move"; y: number; t: number }
  | { type: "end"; height: number }
  | { type: "cancel" }
  | { type: "settled" }
  | { type: "reset" };

export const idleDrag: SheetDrag = {
  phase: "idle",
  startY: 0,
  lastY: 0,
  lastT: 0,
  offset: 0,
  velocity: 0,
};

// Past this share of the sheet's height, letting go closes it.
export const dismissFraction = 0.25;
// A flick down faster than this closes it however short it was.
export const dismissVelocity = 800;
// Pulling up past the top meets resistance and stops here.
export const maxLift = 24;

// The sheet's offset for a finger `dy` px below where it went down.
export function dragOffset(dy: number): number {
  if (dy >= 0) return dy;
  return -Math.min(maxLift, Math.sqrt(-dy) * 2);
}

// Whether letting go here closes the sheet.
export function shouldDismiss(offset: number, velocity: number, height: number): boolean {
  if (offset <= 0) return false;
  return offset > height * dismissFraction || velocity > dismissVelocity;
}

export function sheetDrag(state: SheetDrag, action: SheetDragAction): SheetDrag {
  switch (action.type) {
    case "start":
      if (state.phase === "closing") return state;
      return {
        phase: "dragging",
        startY: action.y,
        lastY: action.y,
        lastT: action.t,
        offset: state.phase === "settling" ? state.offset : 0,
        velocity: 0,
      };
    case "move": {
      if (state.phase !== "dragging") return state;
      const dt = action.t - state.lastT;
      const instant = dt > 0 ? ((action.y - state.lastY) / dt) * 1000 : state.velocity;
      return {
        ...state,
        lastY: action.y,
        lastT: action.t,
        offset: dragOffset(action.y - state.startY),
        // Weighted towards the latest move, so a flick at the end counts.
        velocity: state.velocity * 0.2 + instant * 0.8,
      };
    }
    case "end":
      if (state.phase !== "dragging") return state;
      return shouldDismiss(state.offset, state.velocity, action.height)
        ? { ...state, phase: "closing" }
        : { ...state, phase: "settling", offset: 0, velocity: 0 };
    case "cancel":
      if (state.phase !== "dragging") return state;
      return { ...state, phase: "settling", offset: 0, velocity: 0 };
    case "settled":
      return state.phase === "settling" ? idleDrag : state;
    case "reset":
      return idleDrag;
  }
}

// A damped spring as a CSS `linear()` easing: the sheet springs back with
// this, with no animation library (#110). `bounce` 0 is critically damped;
// the default overshoots a hair, as UIKit's sheet does.
export function springEasing({ duration = 0.5, bounce = 0.12, samples = 40 } = {}): string {
  // SwiftUI's parameterisation: duration ≈ the perceptual settle time.
  const omega = (2 * Math.PI) / duration;
  const zeta = 1 - bounce;
  const points: string[] = [];
  for (let i = 0; i <= samples; i += 1) {
    const t = (i / samples) * duration;
    let x: number;
    if (zeta >= 1) {
      x = 1 - (1 + omega * t) * Math.exp(-omega * t);
    } else {
      const wd = omega * Math.sqrt(1 - zeta * zeta);
      x =
        1 -
        Math.exp(-zeta * omega * t) *
          (Math.cos(wd * t) + ((zeta * omega) / wd) * Math.sin(wd * t));
    }
    points.push(String(Math.round((i === samples ? 1 : x) * 1000) / 1000));
  }
  return `linear(${points.join(", ")})`;
}
