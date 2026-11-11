import { describe, expect, it } from "vite-plus/test";

import {
  lineCount,
  liftNow,
  liftText,
  liftToClear,
  maxLift,
  nudgeLift,
  nudgeSize,
  secondLine,
} from "@/lib/subtitle-position";

describe("nudges", () => {
  it("keep the lift and the size within what a style holds", () => {
    expect(nudgeLift(0, -2)).toBe(0);
    expect(nudgeLift(29, 2)).toBe(maxLift);
    expect(nudgeLift(10, 2)).toBe(12);
    expect(nudgeSize(50, -5)).toBe(50);
    expect(nudgeSize(200, 5)).toBe(200);
    expect(nudgeSize(100, 5)).toBe(105);
  });

  it("say where the subtitles are", () => {
    expect(liftText(0)).toBe("At the bottom");
    expect(liftText(6)).toBe("Raised 6 %");
  });
});

describe("liftToClear", () => {
  it("is how far the controls reach, less the margin mpv leaves anyway", () => {
    // 8 rem = 128 px of 1080: 11.85 % less 3.06 % of margin, rounded up.
    expect(liftToClear(1080, false)).toBe(9);
    // The same bar covers more of a shorter window.
    expect(liftToClear(720, false)).toBe(15);
    expect(liftToClear(720, false)).toBeGreaterThan(liftToClear(1440, false));
  });

  it("never asks for more than a style can hold, or less than nothing", () => {
    expect(liftToClear(200, false)).toBe(maxLift);
    expect(liftToClear(100_000, false)).toBe(0);
    expect(liftToClear(0, false)).toBe(0);
  });

  it("uses the mini player's smaller bar", () => {
    expect(liftToClear(540, true)).toBeLessThan(liftToClear(540, false));
  });
});

describe("liftNow", () => {
  it("raises subtitles to clear the controls while they show", () => {
    expect(liftNow(0, true, 9)).toBe(9);
    expect(liftNow(0, false, 9)).toBe(0);
  });

  it("doesn't add the user's lift to the controls'", () => {
    expect(liftNow(14, true, 9)).toBe(14);
    expect(liftNow(14, false, 9)).toBe(14);
    expect(liftNow(5, true, 9)).toBe(9);
  });
});

describe("secondLine", () => {
  const style = { size: 100, lift: 0 };

  it("sits above the main subtitles, line by line", () => {
    const none = secondLine(1080, style, 0).bottom;
    const one = secondLine(1080, style, 1).bottom;
    const two = secondLine(1080, style, 2).bottom;
    expect(one).toBeGreaterThan(none);
    expect(two - one).toBeGreaterThan(60);
  });

  it("follows the lift and the size of the main subtitles", () => {
    expect(secondLine(1080, { size: 100, lift: 10 }, 1).bottom).toBe(
      secondLine(1080, style, 1).bottom + 108,
    );
    expect(secondLine(1080, { size: 150, lift: 0 }, 1).bottom).toBeGreaterThan(
      secondLine(1080, style, 1).bottom,
    );
  });

  it("is drawn smaller than the main subtitles", () => {
    const { base } = secondLine(1080, style, 1);
    expect(base).toBeCloseTo(1080 * (55 / 720) * 0.7, 5);
    expect(base).toBeLessThan(1080 * (55 / 720));
  });
});

describe("lineCount", () => {
  it("counts the lines showing", () => {
    expect(lineCount("")).toBe(0);
    expect(lineCount("One")).toBe(1);
    expect(lineCount("One\nTwo")).toBe(2);
  });
});
