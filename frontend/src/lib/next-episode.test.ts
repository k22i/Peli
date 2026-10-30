import { describe, expect, it } from "vite-plus/test";

import type { Meta } from "@/lib/addon-protocol";
import { countdownFrom, nextEpisode } from "@/lib/next-episode";

const now = Date.parse("2026-10-31T12:00:00Z");

const show: Meta = {
  id: "tt1",
  type: "series",
  name: "Show",
  videos: [
    { id: "tt1:2:1", title: "Two one", season: 2, episode: 1, released: "2025-01-01" },
    { id: "tt1:1:2", title: "One two", season: 1, episode: 2, released: "2024-01-08" },
    { id: "tt1:0:1", title: "Special", season: 0, episode: 1, released: "2024-06-01" },
    { id: "tt1:1:1", title: "One one", season: 1, episode: 1, released: "2024-01-01" },
    { id: "tt1:2:2", title: "Not out", season: 2, episode: 2, released: "2027-01-01" },
  ],
};

describe("nextEpisode", () => {
  it("is the next one in the season, then the next season's first", () => {
    expect(nextEpisode(show, "tt1:1:1", now)?.id).toBe("tt1:1:2");
    expect(nextEpisode(show, "tt1:1:2", now)?.id).toBe("tt1:2:1");
  });

  it("is none after the last one out, for a special, or for a video it doesn't know", () => {
    expect(nextEpisode(show, "tt1:2:1", now)).toBeUndefined();
    expect(nextEpisode(show, "tt1:0:1", now)).toBeUndefined();
    expect(nextEpisode(show, "tt1:9:9", now)).toBeUndefined();
    expect(nextEpisode({ id: "tt2", type: "movie", name: "Film" }, "tt2", now)).toBeUndefined();
  });
});

describe("countdownFrom", () => {
  it("starts where the file counts as watched, for a minute or more", () => {
    expect(countdownFrom(3000)).toBe(2700);
    expect(countdownFrom(60)).toBe(54);
    expect(countdownFrom(59)).toBeUndefined();
    expect(countdownFrom(0)).toBeUndefined();
  });
});
