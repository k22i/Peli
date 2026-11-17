// The touch player's picture gestures (#131), as a pure reducer: the page
// feeds it the surface's pointer events (and a tick for the hold), and acts
// on what each step puts out. Netflix, YouTube, VLC and Infuse do the same:
//
//   - up and down on the left 40 % is the brightness, on the right 40 % the
//     volume (the centre 20 % does nothing vertically);
//   - sideways anywhere seeks;
//   - a press that holds still for 500 ms plays at 2× until it lifts;
//   - two fingers pinch: out fills the screen, in shows the whole picture;
//   - a short touch that hardly moves is a tap (the page's tapPicture).
//
// Pans don't start within 24 pt of the top or bottom edge, or inside the
// safe-area insets: those swipes are the system's (Control Center, Home).

// Geometry and thresholds, in CSS pixels (points on iOS) and ms.
export const deadEdge = 24;
export const lockAfter = 10;
export const lockRatio = 1.5;
export const tapUnder = 250;
export const tapTravel = 10;
export const holdAfter = 500;
// A drag over this share of the height covers 0 → 100 %.
export const levelSpan = 0.8;
// The full width is this many seconds, or the whole video when shorter.
export const seekSpan = 90;
// The first stretch of a seek moves at a quarter of the speed.
export const slowZone = 40;
export const slowFactor = 0.25;
// Back within this of where the seek started, a release cancels it.
export const seekCancel = 10;
export const fillOver = 1.15;
export const originalUnder = 0.87;

export type Side = "brightness" | "volume";
export type Zone = Side | "centre" | "dead";

type Point = { x: number; y: number };

export type GestureState =
  | { kind: "idle" }
  // One finger down, not yet a pan, a hold or a tap.
  | { kind: "pending"; id: number; start: Point; t0: number; zone: Zone; moved: number }
  | {
      kind: "level";
      id: number;
      side: Side;
      y0: number;
      from: number;
      value: number;
      bumped: boolean;
    }
  | { kind: "seek"; id: number; x0: number; from: number; to: number }
  | { kind: "hold"; id: number }
  | { kind: "pinch"; ids: [number, number]; d0: number; scale: number }
  // The rest of the touch is ignored (a dead-zone pan, a vertical pan in the
  // centre, a turned-off gesture, a pinch that ended): until every finger is up.
  | { kind: "ignored"; ids: number[] };

export type GestureEvent =
  | { type: "down"; id: number; x: number; y: number; t: number }
  | { type: "move"; id: number; x: number; y: number }
  | { type: "up"; id: number; t: number }
  | { type: "cancel"; id: number }
  // The hold's timer: the page sends it holdAfter ms after a down.
  | { type: "tick"; t: number };

export type GestureContext = {
  width: number;
  height: number;
  insets: { top: number; right: number; bottom: number; left: number };
  // The levels when a level pan starts, 0–1.
  brightness: number;
  volume: number;
  // Where the video is and how long it is, in seconds.
  position: number;
  duration: number;
  // Which gestures are on (Settings › Playback › Gestures).
  levels: boolean;
  seek: boolean;
  hold: boolean;
};

export type GestureOutput =
  // A level pan's value; bump is the first time it reached 0 or 1 this touch.
  | { type: "level"; side: Side; value: number; bump: boolean }
  | { type: "level-end"; side: Side }
  | { type: "scrub"; from: number; to: number }
  | { type: "seek"; to: number }
  | { type: "seek-cancel"; from: number }
  | { type: "hold" }
  | { type: "hold-end" }
  | { type: "pinch"; fill: boolean }
  | { type: "tap" };

export type GestureStep = {
  state: GestureState;
  out?: GestureOutput | undefined;
  points: Map<number, Point>;
};

export const idle: GestureState = { kind: "idle" };

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// The zone a touch starts in.
export function zoneOf(p: Point, ctx: Pick<GestureContext, "width" | "height" | "insets">): Zone {
  const { width, height, insets } = ctx;
  if (
    p.y < insets.top + deadEdge ||
    p.y > height - insets.bottom - deadEdge ||
    p.x < insets.left ||
    p.x > width - insets.right
  ) {
    return "dead";
  }
  const inner = width - insets.left - insets.right;
  const x = p.x - insets.left;
  if (x < inner * 0.4) return "brightness";
  if (x > inner * 0.6) return "volume";
  return "centre";
}

// Which way a pan goes once it has travelled far enough: undefined while it
// is too short or too diagonal to say.
export function directionOf(dx: number, dy: number): "level" | "seek" | undefined {
  if (Math.hypot(dx, dy) < lockAfter) return undefined;
  if (Math.abs(dy) > lockRatio * Math.abs(dx)) return "level";
  if (Math.abs(dx) > lockRatio * Math.abs(dy)) return "seek";
  return undefined;
}

// A level after a vertical drag of dy (down is positive): up raises.
export function levelAt(from: number, dy: number, height: number): number {
  if (height <= 0) return from;
  return clamp(from - dy / (height * levelSpan), 0, 1);
}

// How many seconds a horizontal drag of dx moves, with the slow zone.
export function seekBy(dx: number, width: number, duration: number): number {
  if (width <= 0) return 0;
  const span = duration > 0 ? Math.min(seekSpan, duration) : seekSpan;
  const travel = Math.abs(dx);
  const effective =
    travel <= slowZone ? travel * slowFactor : slowZone * slowFactor + (travel - slowZone);
  return (Math.sign(dx) * effective * span) / width;
}

const distance = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);

function idsOf(state: GestureState): number[] {
  switch (state.kind) {
    case "idle":
      return [];
    case "pinch":
      return [...state.ids];
    case "ignored":
      return state.ids;
    default:
      return [state.id];
  }
}

// One step: the next state, the fingers down, and what to do now, if
// anything.
export function reduce(
  state: GestureState,
  points: Map<number, Point>,
  event: GestureEvent,
  ctx: GestureContext,
): GestureStep {
  const next = new Map(points);
  if (event.type === "down") next.set(event.id, { x: event.x, y: event.y });
  else if (event.type === "move") {
    if (!next.has(event.id)) return { state, points };
    next.set(event.id, { x: event.x, y: event.y });
  } else if (event.type === "up" || event.type === "cancel") next.delete(event.id);

  const step = (s: GestureState, out?: GestureOutput): GestureStep => ({
    state: s.kind === "ignored" && next.size === 0 ? idle : s,
    out,
    points: next,
  });

  // A second finger: a pinch, whatever the first was doing. A scrub or a
  // hold in progress is undone first.
  if (
    event.type === "down" &&
    next.size === 2 &&
    state.kind !== "pinch" &&
    state.kind !== "ignored"
  ) {
    const [ida = 0, idb = 0] = next.keys();
    const pa = next.get(ida) ?? { x: 0, y: 0 };
    const pb = next.get(idb) ?? pa;
    const pinch: GestureState = {
      kind: "pinch",
      ids: [ida, idb],
      d0: Math.max(1, distance(pa, pb)),
      scale: 1,
    };
    if (state.kind === "seek") return step(pinch, { type: "seek-cancel", from: state.from });
    if (state.kind === "hold") return step(pinch, { type: "hold-end" });
    if (state.kind === "level") return step(pinch, { type: "level-end", side: state.side });
    return step(pinch);
  }
  if (event.type === "down" && next.size > 2) {
    return step({ kind: "ignored", ids: [...next.keys()] });
  }

  switch (state.kind) {
    case "idle": {
      if (event.type !== "down") return step(state);
      const start = { x: event.x, y: event.y };
      return step({
        kind: "pending",
        id: event.id,
        start,
        t0: event.t,
        zone: zoneOf(start, ctx),
        moved: 0,
      });
    }
    case "pending": {
      if (event.type === "tick") {
        if (ctx.hold && event.t - state.t0 >= holdAfter && state.moved < tapTravel) {
          return step({ kind: "hold", id: state.id }, { type: "hold" });
        }
        return step(state);
      }
      if (event.type === "up" || event.type === "cancel") {
        if (event.id !== state.id) return step(state);
        const tap = event.type === "up" && event.t - state.t0 < tapUnder && state.moved < tapTravel;
        return step(idle, tap ? { type: "tap" } : undefined);
      }
      if (event.type !== "move" || event.id !== state.id) return step(state);
      const dx = event.x - state.start.x;
      const dy = event.y - state.start.y;
      const moved = Math.max(state.moved, Math.hypot(dx, dy));
      const direction = directionOf(dx, dy);
      if (!direction) return step({ ...state, moved });
      if (state.zone === "dead") return step({ kind: "ignored", ids: [state.id] });
      if (direction === "seek") {
        if (!ctx.seek || ctx.duration <= 0) return step({ kind: "ignored", ids: [state.id] });
        const to = clamp(ctx.position + seekBy(dx, ctx.width, ctx.duration), 0, ctx.duration);
        return step(
          { kind: "seek", id: state.id, x0: state.start.x, from: ctx.position, to },
          { type: "scrub", from: ctx.position, to },
        );
      }
      if (state.zone === "centre" || !ctx.levels) return step({ kind: "ignored", ids: [state.id] });
      const side = state.zone;
      const from = side === "brightness" ? ctx.brightness : ctx.volume;
      const value = levelAt(from, dy, ctx.height);
      const bump = value === 0 || value === 1;
      return step(
        { kind: "level", id: state.id, side, y0: state.start.y, from, value, bumped: bump },
        { type: "level", side, value, bump },
      );
    }
    case "level": {
      if (event.type === "move" && event.id === state.id) {
        const value = levelAt(state.from, event.y - state.y0, ctx.height);
        const edge = value === 0 || value === 1;
        const bump = edge && !state.bumped;
        return step(
          { ...state, value, bumped: state.bumped || edge },
          { type: "level", side: state.side, value, bump },
        );
      }
      if ((event.type === "up" || event.type === "cancel") && event.id === state.id) {
        return step(idle, { type: "level-end", side: state.side });
      }
      return step(state);
    }
    case "seek": {
      if (event.type === "move" && event.id === state.id) {
        const to = clamp(
          state.from + seekBy(event.x - state.x0, ctx.width, ctx.duration),
          0,
          ctx.duration,
        );
        return step({ ...state, to }, { type: "scrub", from: state.from, to });
      }
      if (event.type === "cancel" && event.id === state.id) {
        return step(idle, { type: "seek-cancel", from: state.from });
      }
      if (event.type === "up" && event.id === state.id) {
        const back = points.get(state.id);
        const near = back !== undefined && Math.abs(back.x - state.x0) <= seekCancel;
        return step(
          idle,
          near ? { type: "seek-cancel", from: state.from } : { type: "seek", to: state.to },
        );
      }
      return step(state);
    }
    case "hold": {
      if ((event.type === "up" || event.type === "cancel") && event.id === state.id) {
        return step(idle, { type: "hold-end" });
      }
      return step(state);
    }
    case "pinch": {
      const [a, b] = state.ids;
      if (event.type === "move" && (event.id === a || event.id === b)) {
        const pa = next.get(a);
        const pb = next.get(b);
        if (!pa || !pb) return step(state);
        return step({ ...state, scale: distance(pa, pb) / state.d0 });
      }
      if ((event.type === "up" || event.type === "cancel") && (event.id === a || event.id === b)) {
        const rest: GestureState = { kind: "ignored", ids: [...next.keys()] };
        if (event.type === "up" && state.scale > fillOver)
          return step(rest, { type: "pinch", fill: true });
        if (event.type === "up" && state.scale < originalUnder)
          return step(rest, { type: "pinch", fill: false });
        return step(rest);
      }
      return step(state);
    }
    case "ignored": {
      if (event.type === "up" || event.type === "cancel") {
        return step({ kind: "ignored", ids: idsOf(state).filter((id) => id !== event.id) });
      }
      return step(state);
    }
    default:
      return step(state);
  }
}
