import { describe, expect, it } from "vite-plus/test";

import {
  expandedAt,
  hideTabBar,
  nextScroll,
  restingScroll,
  searchSection,
  sectionOf,
  tabSections,
  type ScrollTrack,
} from "@/lib/tab-bar";
import { sections } from "@/sections";

const home = sections[0];
const library = sections.find((section) => section.to === "/library")!;

describe("sectionOf", () => {
  it("finds a section by its root or a page under it", () => {
    expect(sectionOf("/", undefined)).toBe(home);
    expect(sectionOf("/library", undefined)).toBe(library);
    expect(sectionOf("/search", undefined)).toBe(searchSection);
  });

  it("keeps the last section on pages outside them all", () => {
    expect(sectionOf("/title/movie/tt1", library)).toBe(library);
    expect(sectionOf("/folder/abc", home)).toBe(home);
    expect(sectionOf("/settings", undefined)).toBeUndefined();
  });

  it("puts Search beside the capsule, not in it", () => {
    expect(tabSections.map((section) => section.label)).toEqual([
      "Home",
      "Movies",
      "Shows",
      "Anime",
      "Library",
    ]);
  });
});

function scroll(...tops: number[]): ScrollTrack {
  return tops.reduce(nextScroll, restingScroll);
}

describe("nextScroll", () => {
  it("minimises after 48 down and expands after 24 up", () => {
    expect(scroll(20, 47).minimized).toBe(false);
    expect(scroll(20, 48).minimized).toBe(true);
    expect(scroll(20, 300, 290).minimized).toBe(true);
    expect(scroll(20, 300, 276).minimized).toBe(false);
  });

  it("measures from where the direction changed", () => {
    // Up 20 from 300 isn't enough to bring it back.
    expect(scroll(300, 280).minimized).toBe(true);
    // Up 100 brings it back; then 48 down from 200, not from 0, minimises.
    const back = scroll(300, 200);
    expect(back.minimized).toBe(false);
    expect(nextScroll(back, 240).minimized).toBe(false);
    expect(nextScroll(back, 248).minimized).toBe(true);
  });

  it("is full size at the top", () => {
    expect(scroll(400, 0).minimized).toBe(false);
  });

  it("takes another 48 down after a tap expands it", () => {
    const tapped = expandedAt(scroll(400));
    expect(tapped.minimized).toBe(false);
    expect(nextScroll(tapped, 440).minimized).toBe(false);
    expect(nextScroll(tapped, 448).minimized).toBe(true);
  });
});

describe("hideTabBar", () => {
  it("counts each request, and a release twice counts once", async () => {
    const { renderHook, act } = await import("@testing-library/react");
    const { useTabBarHideRequested } = await import("@/lib/tab-bar");
    const { result } = renderHook(() => useTabBarHideRequested());
    expect(result.current).toBe(false);
    let sheet: (() => void) | undefined;
    let keyboard: (() => void) | undefined;
    act(() => {
      sheet = hideTabBar();
      keyboard = hideTabBar();
    });
    expect(result.current).toBe(true);
    act(() => {
      sheet?.();
      sheet?.();
    });
    expect(result.current).toBe(true);
    act(() => keyboard?.());
    expect(result.current).toBe(false);
  });
});
