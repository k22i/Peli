import { describe, expect, it } from "vite-plus/test";

import { withLive } from "@/lib/nav-sections";
import { sectionOf } from "@/lib/tab-bar";
import { liveSection, sections } from "@/sections";

describe("withLive", () => {
  it("leaves the sections as they are without Live TV", () => {
    expect(withLive(sections, false)).toBe(sections);
  });

  it("puts Live TV just before Library, the six in their order", () => {
    const list = withLive(sections, true);

    // Live TV goes before Library as `sections` has them; the top bar is what
    // moves Search to the end.
    expect(list.map((section) => section.label)).toEqual([
      "Home",
      "Movies",
      "Shows",
      "Anime",
      "Search",
      "Live TV",
      "Library",
    ]);
    expect(list[list.indexOf(liveSection) + 1]?.to).toBe("/library");
    // The six keep their order, so ⌘1–6 still point at them.
    expect(list.filter((section) => section !== liveSection)).toEqual([...sections]);
  });

  it("ends the list where there's no Library", () => {
    const without = sections.filter((section) => section.to !== "/library");

    expect(withLive(without, true).at(-1)).toBe(liveSection);
  });
});

describe("sectionOf with Live TV", () => {
  it("counts /live as a section of its own", () => {
    expect(sectionOf("/live", undefined)).toBe(liveSection);
  });

  it("keeps it on a page that is nobody's section", () => {
    expect(sectionOf("/title/movie/tt1", liveSection)).toBe(liveSection);
  });
});
