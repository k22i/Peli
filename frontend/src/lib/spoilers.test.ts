import { describe, expect, it } from "vite-plus/test";

import { hidesSpoilers, isRevealed, resetRevealed, revealSpoiler } from "@/lib/spoilers";

const unseen = { watched: false, started: false, revealed: false };

describe("hidesSpoilers", () => {
  it("hides nothing with the setting off", () => {
    expect(hidesSpoilers(false, unseen)).toBe(false);
  });

  it("hides an episode not watched or started", () => {
    expect(hidesSpoilers(true, unseen)).toBe(true);
  });

  it("shows one watched, started or revealed", () => {
    expect(hidesSpoilers(true, { ...unseen, watched: true })).toBe(false);
    expect(hidesSpoilers(true, { ...unseen, started: true })).toBe(false);
    expect(hidesSpoilers(true, { ...unseen, revealed: true })).toBe(false);
  });
});

describe("revealSpoiler", () => {
  it("reveals an episode until reset", () => {
    resetRevealed();
    expect(isRevealed("tt0903747:1:2")).toBe(false);
    revealSpoiler("tt0903747:1:2");
    expect(isRevealed("tt0903747:1:2")).toBe(true);
    expect(isRevealed("tt0903747:1:3")).toBe(false);
    resetRevealed();
    expect(isRevealed("tt0903747:1:2")).toBe(false);
  });
});
