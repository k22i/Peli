import { describe, expect, it } from "vite-plus/test";

import type { Meta } from "@/lib/addon-protocol";

import { episodeMapOf, runtimeMinutes, titleContext, videoNumbers } from "./context";

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

  it("takes TMDB's other names as aliases, once each and without the name", () => {
    const ctx = titleContext(
      "movie",
      "tt0111161",
      { ...meta, name: "The Shawshank Redemption" },
      "x",
      {
        aliases: ["Cadena perpetua", "the shawshank redemption", "Les Évadés", "cadena perpetua", ""],
      },
    );
    expect(ctx.aliases).toEqual(["Cadena perpetua", "Les Évadés"]);
  });

  it("adds them to the addon's own aliases", () => {
    const kitsu = { ...meta, id: "kitsu:1", aliases: ["Sousou no Frieren", "Frieren"] };
    expect(
      titleContext("series", "kitsu:1:1", kitsu, "x", { aliases: ["葬送のフリーレン", "Frieren"] })
        .aliases,
    ).toEqual(["Sousou no Frieren", "Frieren", "葬送のフリーレン"]);
  });

  it("has no aliases without TMDB's, or the addon's", () => {
    expect(titleContext("movie", "tt1", meta, "x")).not.toHaveProperty("aliases");
    expect(titleContext("movie", "tt1", meta, "x", { aliases: [] })).not.toHaveProperty("aliases");
    expect(titleContext("movie", "tt1", { ...meta, aliases: [] }, "x")).not.toHaveProperty(
      "aliases",
    );
  });

  it("knows anime by its Kitsu id or its genre", () => {
    expect(titleContext("series", "kitsu:46474:1", undefined, "Frieren").anime).toBe(true);
    expect(titleContext("series", "tt1:1:1", { ...meta, genres: ["Anime"] }, "x").anime).toBe(true);
  });
});

describe("episodeMapOf", () => {
  const meta: Meta = {
    id: "kitsu:12",
    type: "series",
    name: "One Piece",
    videos: [
      {
        id: "kitsu:12:1100",
        title: "Powers on a Different Level!",
        season: 1,
        episode: 1100,
        imdbSeason: 22,
        imdbEpisode: 15,
        absoluteEpisode: 1100,
      },
      { id: "kitsu:12:1101", title: "Episode 1101", season: 1, episode: 1101 },
    ],
  };

  it("reads the numbers by season from the video the Kitsu addon sends", () => {
    expect(episodeMapOf(meta, "kitsu:12:1100")).toEqual({
      season: 22,
      episode: 15,
      absolute: 1100,
    });
  });

  it("has none for a video without them (the AniList addon's), another video, or no details", () => {
    expect(episodeMapOf(meta, "kitsu:12:1101")).toBeUndefined();
    expect(episodeMapOf(meta, "kitsu:12:5")).toBeUndefined();
    expect(episodeMapOf(undefined, "kitsu:12:1100")).toBeUndefined();
  });

  it("goes into the title context only when given, beside the aliases", () => {
    const map = { season: 22, episode: 15, absolute: 1100 };
    expect(titleContext("series", "kitsu:12:1100", meta, "One Piece", { map }).map).toEqual(map);
    expect(titleContext("series", "kitsu:12:1100", meta, "One Piece")).not.toHaveProperty("map");
  });
});
