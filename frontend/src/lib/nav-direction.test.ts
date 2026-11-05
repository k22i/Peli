import { describe, expect, it } from "vite-plus/test";

import { navDirection } from "@/lib/nav-direction";

const at = (pathname: string, index?: number) => ({
  pathname,
  state: index === undefined ? {} : { __TSR_index: index },
});

describe("navDirection", () => {
  it("goes forward into a title, a folder or the stream picker", () => {
    expect(navDirection(at("/", 0), at("/title/movie/tt1", 1))).toBe("forward");
    expect(navDirection(at("/", 0), at("/folder/c/f", 1))).toBe("forward");
    expect(navDirection(at("/title/movie/tt1", 1), at("/streams/movie/tt1", 2))).toBe("forward");
  });

  it("goes back whenever history steps back, to a page or a section", () => {
    expect(navDirection(at("/title/movie/tt1", 1), at("/", 0))).toBe("back");
    expect(navDirection(at("/streams/movie/tt1", 2), at("/title/movie/tt1", 1))).toBe("back");
    expect(navDirection(at("/player", 3), at("/streams/movie/tt1", 2))).toBe("back");
  });

  it("keeps the quick cross-fade between sections", () => {
    expect(navDirection(at("/", 0), at("/movies", 1))).toBe("section");
    expect(navDirection(at("/title/movie/tt1", 1), at("/library", 2))).toBe("section");
    expect(navDirection(at("/", 0), at("/settings", 1))).toBe("section");
  });

  it("treats a change of search on the same page, or a replace, as a section", () => {
    expect(navDirection(at("/movies", 1), at("/movies", 2))).toBe("section");
    expect(navDirection(at("/settings", 1), at("/settings", 0))).toBe("section");
    expect(navDirection(at("/", 1), at("/title/movie/tt1", 1))).toBe("section");
  });

  it("falls back to a section when a place or its index is unknown", () => {
    expect(navDirection(undefined, at("/title/movie/tt1", 1))).toBe("section");
    expect(navDirection(at("/", 0), at("/title/movie/tt1"))).toBe("section");
  });
});
