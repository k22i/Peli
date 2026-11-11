import { describe, expect, it } from "vite-plus/test";

import { loopArgs, loopOf, nextLoop, nextLoopLabel, sameLoop } from "@/lib/ab-loop";

describe("nextLoop", () => {
  it("sets A, then B, then clears", () => {
    const a = nextLoop({}, 65);
    expect(a.loop).toEqual({ a: 65 });
    expect(a.text).toBe("Loop from 1:05, L again to end it");
    const b = nextLoop(a.loop, 90);
    expect(b.loop).toEqual({ a: 65, b: 90 });
    expect(b.text).toBe("Looping 1:05–1:30");
    expect(nextLoop(b.loop, 70)).toEqual({ loop: {}, text: "A–B loop off" });
  });

  it("makes B before or right at A a new A", () => {
    expect(nextLoop({ a: 65 }, 30).loop).toEqual({ a: 30 });
    expect(nextLoop({ a: 65 }, 65.2).loop).toEqual({ a: 65.2 });
  });

  it("never starts before the file", () => {
    expect(nextLoop({}, -1).loop).toEqual({ a: 0 });
  });
});

describe("nextLoopLabel", () => {
  it("names what L does next", () => {
    expect(nextLoopLabel({})).toBe("Start a loop here (A)");
    expect(nextLoopLabel({ a: 1 })).toBe("End the loop here (B)");
    expect(nextLoopLabel({ a: 1, b: 2 })).toBe("Clear A–B loop");
  });
});

describe("loopArgs and loopOf", () => {
  it("turn unset ends into Go's -1 and back from its null", () => {
    expect(loopArgs({})).toEqual([-1, -1]);
    expect(loopArgs({ a: 3 })).toEqual([3, -1]);
    expect(loopOf({ loopA: null, loopB: null })).toEqual({});
    expect(loopOf({ loopA: 3, loopB: 9 })).toEqual({ a: 3, b: 9 });
  });
});

describe("sameLoop", () => {
  it("allows mpv's rounding", () => {
    expect(sameLoop({ a: 3 }, { a: 3.000001 })).toBe(true);
    expect(sameLoop({ a: 3 }, { a: 3, b: 5 })).toBe(false);
    expect(sameLoop({}, {})).toBe(true);
  });
});
