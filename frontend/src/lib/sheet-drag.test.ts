import { describe, expect, it } from "vite-plus/test";

import {
  dragOffset,
  idleDrag,
  maxLift,
  sheetDrag,
  shouldDismiss,
  springEasing,
  type SheetDrag,
  type SheetDragAction,
} from "@/lib/sheet-drag";

const run = (actions: SheetDragAction[], from: SheetDrag = idleDrag) =>
  actions.reduce(sheetDrag, from);

// A drag from y=100 on a 400 px sheet, `to` px down, over `ms`, in steps.
function drag(to: number, ms: number, steps = 10): SheetDrag {
  const actions: SheetDragAction[] = [{ type: "start", y: 100, t: 0, height: 400 }];
  for (let i = 1; i <= steps; i += 1) {
    actions.push({ type: "move", y: 100 + (to * i) / steps, t: (ms * i) / steps });
  }
  return run(actions);
}

describe("sheet drag", () => {
  it("follows the finger down", () => {
    const state = drag(120, 600);
    expect(state.phase).toBe("dragging");
    expect(state.offset).toBe(120);
  });

  it("closes past a quarter of the height", () => {
    expect(sheetDrag(drag(101, 1000), { type: "end" }).phase).toBe("closing");
  });

  it("springs back short of a quarter, when slow", () => {
    const state = sheetDrag(drag(99, 1000), { type: "end" });
    expect(state).toMatchObject({ phase: "settling", offset: 0 });
    expect(sheetDrag(state, { type: "settled" })).toEqual(idleDrag);
  });

  it("closes on a flick faster than 800 pt/s however short", () => {
    // 60 px in 50 ms: 1,200 px/s.
    const flick = drag(60, 50, 5);
    expect(flick.velocity).toBeGreaterThan(800);
    expect(sheetDrag(flick, { type: "end" }).phase).toBe("closing");
  });

  it("doesn't close on a slow short drag", () => {
    // 60 px in 600 ms: 100 px/s.
    expect(sheetDrag(drag(60, 600), { type: "end" }).phase).toBe("settling");
  });

  it("never closes when pulled up, and resists past the top", () => {
    const up = drag(-400, 50, 5);
    expect(up.offset).toBe(-maxLift);
    expect(sheetDrag(up, { type: "end" }).phase).toBe("settling");
    expect(dragOffset(-4)).toBeCloseTo(-4);
    expect(dragOffset(10)).toBe(10);
  });

  it("springs back when the system cancels the touch", () => {
    expect(sheetDrag(drag(300, 300), { type: "cancel" }).phase).toBe("settling");
  });

  it("ignores moves and ends with no drag going", () => {
    expect(sheetDrag(idleDrag, { type: "move", y: 300, t: 10 })).toBe(idleDrag);
    expect(sheetDrag(idleDrag, { type: "end" })).toBe(idleDrag);
  });

  it("stays closing once let go to close", () => {
    const closing = sheetDrag(drag(200, 500), { type: "end" });
    expect(sheetDrag(closing, { type: "start", y: 0, t: 0, height: 400 })).toBe(closing);
    expect(sheetDrag(closing, { type: "reset" })).toEqual(idleDrag);
  });

  it("decides with the thresholds", () => {
    expect(shouldDismiss(100, 0, 400)).toBe(false);
    expect(shouldDismiss(100.5, 0, 400)).toBe(true);
    expect(shouldDismiss(10, 801, 400)).toBe(true);
    expect(shouldDismiss(0, 2000, 400)).toBe(false);
  });
});

describe("spring easing", () => {
  it("is a linear() curve from 0 to 1 that overshoots a hair", () => {
    const easing = springEasing();
    const points = easing.slice("linear(".length, -1).split(", ").map(Number);
    expect(points[0]).toBe(0);
    expect(points.at(-1)).toBe(1);
    expect(Math.max(...points)).toBeGreaterThan(1);
    expect(Math.max(...points)).toBeLessThan(1.05);
  });

  it("doesn't overshoot when critically damped", () => {
    const points = springEasing({ bounce: 0 }).slice(7, -1).split(", ").map(Number);
    expect(Math.max(...points)).toBeLessThanOrEqual(1);
  });
});
