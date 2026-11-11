import { describe, expect, it } from "vite-plus/test";

import {
  episodeMargin,
  fadedVolume,
  sleepChoiceOf,
  sleepHint,
  sleepLeft,
  sleepOff,
  sleepTimerFor,
} from "@/lib/sleep-timer";

const playing = { position: 100, duration: 1300, speed: 1 };

describe("sleepTimerFor", () => {
  it("sets minutes from now, or the file's end", () => {
    expect(sleepTimerFor("30", "a", 1000)).toEqual({
      kind: "minutes",
      minutes: 30,
      ends: 1_801_000,
    });
    expect(sleepTimerFor("episode", "a", 1000)).toEqual({ kind: "episode", file: "a" });
    expect(sleepTimerFor("off", "a", 1000)).toBe(sleepOff);
  });

  it("goes back to its choice", () => {
    expect(sleepChoiceOf(sleepTimerFor("15", "a", 0))).toBe("15");
    expect(sleepChoiceOf(sleepTimerFor("episode", "a", 0))).toBe("episode");
    expect(sleepChoiceOf(sleepOff)).toBe("off");
  });
});

describe("sleepLeft", () => {
  it("counts minutes in wall time", () => {
    expect(sleepLeft({ kind: "minutes", minutes: 15, ends: 61_000 }, 1000, playing)).toBe(60);
    expect(sleepLeft({ kind: "minutes", minutes: 15, ends: 1000 }, 5000, playing)).toBe(0);
  });

  it("counts an episode to just before its end, faster at a higher speed", () => {
    const timer = { kind: "episode", file: "a" } as const;
    expect(sleepLeft(timer, 0, playing)).toBeCloseTo(1200 - episodeMargin);
    expect(sleepLeft(timer, 0, { ...playing, speed: 2 })).toBeCloseTo((1200 - episodeMargin) / 2);
    expect(sleepLeft(timer, 0, { ...playing, duration: 0 })).toBeUndefined();
  });

  it("is off when off", () => {
    expect(sleepLeft(sleepOff, 0, playing)).toBeUndefined();
  });
});

describe("fadedVolume", () => {
  it("keeps the volume until the last 10 s, then fades it to nothing", () => {
    expect(fadedVolume(80, 60)).toBe(80);
    expect(fadedVolume(80, 10)).toBe(80);
    expect(fadedVolume(80, 5)).toBe(20);
    expect(fadedVolume(80, 0)).toBe(0);
  });
});

describe("sleepHint", () => {
  it("says what's left", () => {
    expect(sleepHint(sleepOff, undefined)).toBeUndefined();
    expect(sleepHint({ kind: "episode", file: "a" }, 30)).toBe("End of episode");
    expect(sleepHint({ kind: "minutes", minutes: 15, ends: 0 }, 690)).toBe("12 min");
    expect(sleepHint({ kind: "minutes", minutes: 15, ends: 0 }, 5)).toBe("1 min");
  });
});
