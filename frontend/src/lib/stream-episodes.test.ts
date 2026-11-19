import { describe, expect, it } from "vite-plus/test";

import type { Meta } from "@/lib/addon-protocol";

import { neighbours } from "./stream-episodes";

const show: Meta = {
  id: "tt1",
  type: "series",
  name: "Show",
  videos: [
    { id: "tt1:0:1", title: "Special", season: 0, episode: 1 },
    { id: "tt1:1:2", title: "Two", season: 1, episode: 2 },
    { id: "tt1:1:1", title: "One", season: 1, episode: 1 },
    { id: "tt1:2:1", title: "Three", season: 2, episode: 1 },
  ],
};

describe("neighbours", () => {
  it("finds the episodes either side, in the title's order", () => {
    const near = neighbours(show, "tt1:1:2");
    expect(near.previous?.id).toBe("tt1:1:1");
    expect(near.next?.id).toBe("tt1:2:1");
  });

  it("has no previous for the first or no next for the last (Specials go last)", () => {
    expect(neighbours(show, "tt1:1:1").previous).toBeUndefined();
    expect(neighbours(show, "tt1:0:1").next).toBeUndefined();
    expect(neighbours(show, "tt1:2:1").next?.id).toBe("tt1:0:1");
  });

  it("has none for a film, an unknown episode or no details", () => {
    expect(neighbours(show, "tt9")).toEqual({});
    expect(neighbours(undefined, "tt1:1:1")).toEqual({});
  });
});
