import { describe, expect, it } from "vite-plus/test";

import { sameSpeed, speedLabel, speeds, stepSpeed } from "@/lib/speed";

describe("stepSpeed", () => {
  it("moves one step either way", () => {
    expect(stepSpeed(1, 1)).toBe(1.25);
    expect(stepSpeed(1, -1)).toBe(0.75);
    expect(stepSpeed(2, 1)).toBe(2.5);
  });

  it("holds at the ends", () => {
    expect(stepSpeed(4, 1)).toBe(4);
    expect(stepSpeed(0.25, -1)).toBe(0.25);
  });

  it("goes from a speed between steps to the next one that way", () => {
    expect(stepSpeed(1.03, 1)).toBe(1.25);
    expect(stepSpeed(1.03, -1)).toBe(1);
  });

  it("stays within Go's range", () => {
    expect(Math.min(...speeds)).toBe(0.25);
    expect(Math.max(...speeds)).toBe(4);
  });
});

describe("speedLabel", () => {
  it("names a speed without trailing zeros", () => {
    expect(speedLabel(1)).toBe("1×");
    expect(speedLabel(1.25)).toBe("1.25×");
    expect(speedLabel(0.5)).toBe("0.5×");
    expect(speedLabel(1.0300001)).toBe("1.03×");
  });
});

describe("sameSpeed", () => {
  it("counts a party's nudge as the step it's near", () => {
    expect(sameSpeed(1.03, 1)).toBe(true);
    expect(sameSpeed(1.25, 1)).toBe(false);
  });
});
