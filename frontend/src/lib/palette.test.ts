import { describe, expect, it } from "vite-plus/test";

import { commandMatches, isPaletteShortcut, recentCount, recentTitles } from "@/lib/palette";

const key = (init: KeyboardEventInit) =>
  new KeyboardEvent("keydown", { cancelable: true, ...init });

describe("isPaletteShortcut", () => {
  it("takes Ctrl or ⌘ with K, and nothing more", () => {
    expect(isPaletteShortcut(key({ key: "k", metaKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ key: "K", ctrlKey: true }))).toBe(true);
    expect(isPaletteShortcut(key({ key: "k" }))).toBe(false);
    expect(isPaletteShortcut(key({ key: "k", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isPaletteShortcut(key({ key: "k", metaKey: true, altKey: true }))).toBe(false);
    expect(isPaletteShortcut(key({ key: "f", metaKey: true }))).toBe(false);
  });

  it("leaves a key someone already handled", () => {
    const event = key({ key: "k", metaKey: true });
    event.preventDefault();
    expect(isPaletteShortcut(event)).toBe(false);
  });
});

describe("commandMatches", () => {
  it("matches the start of every word typed", () => {
    expect(commandMatches("Settings: Playback", "", "set pl")).toBe(true);
    expect(commandMatches("Upcoming", "calendar episodes", "cal")).toBe(true);
    expect(commandMatches("Home", "", "ome")).toBe(false);
    expect(commandMatches("Home", "", "home movies")).toBe(false);
  });
});

describe("recentTitles", () => {
  it("is the newest watched, capped", () => {
    const items = Array.from({ length: 9 }, (_, i) => ({ contentId: `tt${i}` }));
    const watched = Object.fromEntries(items.slice(1).map((item, i) => [item.contentId, i + 1]));
    const recent = recentTitles(items, watched);
    expect(recent).toHaveLength(recentCount);
    expect(recent[0]?.contentId).toBe("tt8");
    expect(recent.some((item) => item.contentId === "tt0")).toBe(false);
  });
});
