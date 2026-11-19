import { describe, expect, it } from "vite-plus/test";

import { clockTime, endsAt, remainingSeconds, runtimeSeconds, untilNextStep } from "@/lib/ends-at";

// 2026-11-19 21:30:00 local time.
const now = new Date(2026, 10, 19, 21, 30, 0).getTime();

describe("endsAt", () => {
  it("adds what's left to now", () => {
    expect(endsAt(now, 72 * 60)).toBe(new Date(2026, 10, 19, 22, 42, 0).getTime());
  });

  it("plays faster at a higher speed", () => {
    expect(endsAt(now, 60 * 60, 2)).toBe(now + 30 * 60_000);
  });

  it("has no end for nothing left or a stopped speed", () => {
    expect(endsAt(now, 0)).toBeUndefined();
    expect(endsAt(now, Number.NaN)).toBeUndefined();
    expect(endsAt(now, 60, 0)).toBeUndefined();
  });

  it("moves forward as time passes while paused", () => {
    const later = now + 5 * 60_000;
    expect(endsAt(later, 600)! - endsAt(now, 600)!).toBe(5 * 60_000);
  });
});

describe("clockTime", () => {
  const end = new Date(2026, 10, 19, 22, 42, 0).getTime();

  it("writes the locale's 12-hour clock", () => {
    expect(clockTime(end, "en-US")).toMatch(/^10:42\s?PM$/);
  });

  it("writes the locale's 24-hour clock", () => {
    expect(clockTime(end, "en-GB")).toBe("22:42");
    expect(clockTime(end, "de-DE")).toBe("22:42");
  });

  it("follows an explicit hour cycle", () => {
    expect(clockTime(end, "en-US", "h23")).toBe("22:42");
  });
});

describe("runtimeSeconds", () => {
  it.each([
    ["49 min", 49 * 60],
    ["1h 30min", 90 * 60],
    ["2 h", 120 * 60],
    ["2h 3m", 123 * 60],
    ["142", 142 * 60],
    ["1:45", 105 * 60],
  ])("reads %s", (text, seconds) => {
    expect(runtimeSeconds(text)).toBe(seconds);
  });

  it.each([undefined, "", "N/A", "0"])("has nothing for %s", (text) => {
    expect(runtimeSeconds(text)).toBeUndefined();
  });
});

describe("remainingSeconds", () => {
  it("is the whole runtime with no progress", () => {
    expect(remainingSeconds("49 min")).toBe(49 * 60);
  });

  it("takes what's left from progress, in ms", () => {
    expect(remainingSeconds("49 min", { position: 600_000, duration: 3_000_000 })).toBe(2400);
  });

  it("falls back to the runtime when progress has no duration", () => {
    expect(remainingSeconds("10 min", { position: 120_000, duration: 0 })).toBe(480);
  });

  it("has nothing with neither", () => {
    expect(remainingSeconds(undefined)).toBeUndefined();
  });
});

describe("untilNextStep", () => {
  it("waits for the next minute's turn", () => {
    expect(untilNextStep(now + 15_000)).toBe(45_000);
    expect(untilNextStep(now)).toBe(60_000);
    expect(untilNextStep(now + 400, 1000)).toBe(600);
  });
});
