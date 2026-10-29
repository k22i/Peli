import { describe, expect, it } from "vite-plus/test";

import type { Progress, WatchedItem } from "@bindings/store";
import type { Meta } from "@/lib/addon-protocol";
import { parseMetaResponse } from "@/lib/addon-protocol/parse";
import cinemetaMovie from "@/lib/addon-protocol/fixtures/cinemeta/meta-movie.json";
import {
  episodeMarks,
  episodes,
  libraryItem,
  mainEpisodes,
  playChoice,
  seasons,
  seriesMarkChange,
  titleSearch,
  titleState,
} from "@/lib/title";

const now = Date.parse("2026-10-29T00:00:00Z");
const movie = parseMetaResponse(cinemetaMovie).meta;

// A series with two seasons of three, Specials, and an episode still to air.
const show: Meta = {
  id: "tt9",
  type: "series",
  name: "Show",
  videos: [
    { id: "tt9:2:1", title: "Two one", season: 2, episode: 1, released: "2020-02-01T00:00:00Z" },
    { id: "tt9:0:1", title: "Special", season: 0, episode: 1, released: "2019-06-01T00:00:00Z" },
    { id: "tt9:1:2", title: "One two", season: 1, episode: 2, released: "2019-01-08T00:00:00Z" },
    { id: "tt9:1:1", title: "One one", season: 1, episode: 1, released: "2019-01-01T00:00:00Z" },
    { id: "tt9:1:3", title: "One three", season: 1, episode: 3, released: "2019-01-15T00:00:00Z" },
    { id: "tt9:2:2", title: "Two two", season: 2, episode: 2, released: "2020-02-08T00:00:00Z" },
    { id: "tt9:2:3", title: "Two three", season: 2, episode: 3, released: "2027-01-01T00:00:00Z" },
  ],
};

const mark = (season?: number, episode?: number): WatchedItem => ({
  contentId: "tt9",
  contentType: "series",
  season: season ?? null,
  episode: episode ?? null,
  watchedAt: 1,
});
const progress = (
  season: number | undefined,
  episode: number | undefined,
  position: number,
  lastWatched = 1,
): Progress => ({
  key: "",
  contentId: "tt9",
  contentType: "series",
  videoId: season === undefined ? "tt9" : `tt9:${season}:${episode}`,
  season: season ?? null,
  episode: episode ?? null,
  position,
  duration: 1000,
  lastWatched,
});

const codes = (list: readonly { season: number; episode: number }[]) =>
  list.map((e) => `${e.season}x${e.episode}`);

describe("episodes", () => {
  it("orders seasons 1 and up, then Specials", () => {
    const list = episodes(show);
    expect(codes(list)).toEqual(["1x1", "1x2", "1x3", "2x1", "2x2", "2x3", "0x1"]);
    expect(seasons(list)).toEqual([1, 2, 0]);
  });

  it("counts only aired episodes outside Specials for the series", () => {
    expect(codes(mainEpisodes(episodes(show), now))).toEqual(["1x1", "1x2", "1x3", "2x1", "2x2"]);
  });
});

describe("titleState", () => {
  it("counts an episode watched when marked or at 90 %", () => {
    const state = titleState(show, [mark(1, 1)], [progress(1, 2, 900), progress(1, 3, 500)], now);
    const [e11, e12, e13, e21] = episodes(show);
    expect([e11, e12, e13, e21].map((e) => state.watched(e))).toEqual([true, true, false, false]);
    expect(state.progress(e12)).toBeUndefined();
    expect(state.progress(e13)?.position).toBe(500);
  });

  it("calls a series watched when every aired main episode is", () => {
    const all = [mark(1, 1), mark(1, 2), mark(1, 3), mark(2, 1), mark(2, 2)];
    expect(titleState(show, all, [], now).seriesWatched).toBe(true);
    // The special and the unaired episode don't count; a missing one does.
    expect(titleState(show, all.slice(1), [], now).seriesWatched).toBe(false);
  });

  it("reads a film's own mark or progress", () => {
    const film = (marks: WatchedItem[], entries: Progress[]) =>
      titleState(movie, marks, entries, now).watched();
    expect(film([{ ...mark(), contentId: movie.id }], [])).toBe(true);
    expect(film([], [progress(undefined, undefined, 950)])).toBe(true);
    expect(film([], [progress(undefined, undefined, 100)])).toBe(false);
  });
});

describe("seriesMarkChange", () => {
  const all = [mark(1, 1), mark(1, 2), mark(1, 3), mark(2, 1), mark(2, 2)];

  it("adds the series mark once every episode is watched, and drops it after", () => {
    expect(seriesMarkChange(show, titleState(show, all, []))).toBe(true);
    expect(seriesMarkChange(show, titleState(show, [mark(), ...all], []))).toBeUndefined();
    expect(seriesMarkChange(show, titleState(show, [mark(), ...all.slice(1)], []))).toBe(false);
  });

  it("leaves films alone", () => {
    expect(seriesMarkChange(movie, titleState(movie, [], []))).toBeUndefined();
  });
});

describe("playChoice", () => {
  it("resumes a film, or plays it", () => {
    const entries = [{ ...progress(undefined, undefined, 300), contentId: movie.id }];
    expect(playChoice(movie, titleState(movie, [], entries), entries)).toMatchObject({
      label: "Resume",
      target: { id: movie.id, videoId: "tt0111161", resumeAt: 300 },
    });
    expect(playChoice(movie, titleState(movie, [], []), [])?.label).toBe("Play");
  });

  it("resumes the latest episode in progress", () => {
    const entries = [progress(1, 2, 300, 5), progress(2, 1, 300, 9)];
    const choice = playChoice(show, titleState(show, [], entries, now), entries, now);
    expect(choice).toMatchObject({
      label: "Resume S2 · E1",
      resume: true,
      target: { videoId: "tt9:2:1", resumeAt: 300 },
    });
  });

  it("plays the episode after the furthest one watched, then starts over", () => {
    const marks = [mark(1, 1), mark(1, 3)];
    expect(playChoice(show, titleState(show, marks, [], now), [], now)?.label).toBe("Play S2 · E1");
    expect(playChoice(show, titleState(show, [], [], now), [], now)?.label).toBe("Play S1 · E1");
    const all = [mark(1, 1), mark(1, 2), mark(1, 3), mark(2, 1), mark(2, 2)];
    expect(playChoice(show, titleState(show, all, [], now), [], now)?.label).toBe("Play S1 · E1");
  });
});

describe("marks", () => {
  it("names episodes as Nuvio does", () => {
    const [first] = episodes(show);
    expect(episodeMarks(show, [first!], 7)).toEqual([
      {
        contentId: "tt9",
        contentType: "series",
        title: "One one",
        season: 1,
        episode: 1,
        watchedAt: 7,
      },
    ]);
  });

  it("saves a film to the library with its details", () => {
    expect(libraryItem(movie, "https://v3-cinemeta.strem.io/manifest.json", 5)).toMatchObject({
      contentId: "tt0111161",
      contentType: "movie",
      name: "The Shawshank Redemption",
      imdbRating: Number.parseFloat(movie.imdbRating!),
      addonBaseUrl: "https://v3-cinemeta.strem.io",
      addedAt: 5,
    });
  });
});

describe("titleSearch", () => {
  it("keeps a season number", () => {
    expect(titleSearch({ season: 2 })).toEqual({ season: 2 });
    expect(titleSearch({ season: "0" })).toEqual({ season: 0 });
    expect(titleSearch({ season: "x" })).toEqual({});
    expect(titleSearch({ season: "" })).toEqual({});
    expect(titleSearch({})).toEqual({});
  });
});
