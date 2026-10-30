import { describe, expect, it } from "vite-plus/test";

import type { Meta } from "@/lib/addon-protocol";

import { runtimeMinutes, titleContext, videoNumbers } from "./context";

describe("runtimeMinutes", () => {
  it.each([
    ["142 min", 142],
    ["2h 22min", 142],
    ["2h", 120],
    ["", undefined],
    [undefined, undefined],
  ])("reads %j as %j", (runtime, minutes) => {
    expect(runtimeMinutes(runtime)).toBe(minutes);
  });
});

describe("videoNumbers", () => {
  it("reads an episode's season and number, or Kitsu's episode", () => {
    expect(videoNumbers("tt0903747:1:2")).toEqual({ season: 1, episode: 2 });
    expect(videoNumbers("kitsu:46474:3")).toEqual({ episode: 3 });
    expect(videoNumbers("tt0111161")).toEqual({});
  });
});

describe("titleContext", () => {
  const meta: Meta = {
    id: "tt0903747",
    type: "series",
    name: "Breaking Bad",
    releaseInfo: "2008–2013",
    runtime: "49 min",
    genres: ["Drama"],
  };

  it("takes the name, year and runtime from the details, the rest from the id", () => {
    expect(titleContext("series", "tt0903747:1:2", meta, "Breaking Bad S1 · E2")).toEqual({
      type: "series",
      anime: false,
      id: "tt0903747:1:2",
      name: "Breaking Bad",
      year: 2008,
      runtimeMin: 49,
      season: 1,
      episode: 2,
    });
  });

  it("falls back to the heading without details", () => {
    expect(titleContext("movie", "tt0111161", undefined, "The Shawshank Redemption")).toEqual({
      type: "movie",
      anime: false,
      id: "tt0111161",
      name: "The Shawshank Redemption",
    });
  });

  it("knows anime by its Kitsu id or its genre", () => {
    expect(titleContext("series", "kitsu:46474:1", undefined, "Frieren").anime).toBe(true);
    expect(titleContext("series", "tt1:1:1", { ...meta, genres: ["Anime"] }, "x").anime).toBe(true);
  });
});
