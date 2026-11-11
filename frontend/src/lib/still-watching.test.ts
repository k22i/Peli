import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vite-plus/test";

import { stillWatchingDue, useEpisodesWithoutInput } from "@/lib/still-watching";

describe("stillWatchingDue", () => {
  it("asks once the episodes in a row reach the profile's number", () => {
    // The first episode was picked; two more started by themselves.
    expect(stillWatchingDue(3, 0)).toBe(false);
    expect(stillWatchingDue(3, 1)).toBe(false);
    expect(stillWatchingDue(3, 2)).toBe(true);
    expect(stillWatchingDue(2, 1)).toBe(true);
  });

  it("never asks when off, and asks after 3 without a setting", () => {
    expect(stillWatchingDue(0, 50)).toBe(false);
    expect(stillWatchingDue(undefined, 2)).toBe(true);
  });
});

describe("useEpisodesWithoutInput", () => {
  it("goes back to 0 on a key or the pointer", () => {
    const { result } = renderHook(() => useEpisodesWithoutInput());
    result.current.current = 2;
    window.dispatchEvent(new KeyboardEvent("keydown", { key: "a" }));
    expect(result.current.current).toBe(0);
    result.current.current = 2;
    window.dispatchEvent(new Event("pointermove"));
    expect(result.current.current).toBe(0);
  });
});
