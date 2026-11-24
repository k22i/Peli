import { describe, expect, it } from "vite-plus/test";

import {
  episodeLabels,
  libraryItems,
  libraryMeta,
  librarySearch,
  libraryTypes,
} from "@/lib/library";
import type { LibraryItem, Progress } from "@bindings/store";

const item = (contentId: string, contentType: string, name: string, addedAt: number) =>
  ({ contentId, contentType, name, addedAt }) as LibraryItem;

// As the store gives them: most recently added first.
const library = [
  item("tt3", "series", "the Wire", 30),
  item("kitsu:1", "anime", "Frieren", 20),
  item("tt2", "movie", "Heat", 10),
  item("tt10", "movie", "Alien 10", 5),
  item("tt9", "movie", "Alien 9", 1),
];
const ids = (items: LibraryItem[]) => items.map((entry) => entry.contentId);

describe("libraryItems", () => {
  it("sorts by date added, newest first, by default", () => {
    expect(ids(libraryItems(library, {}))).toEqual(["tt3", "kitsu:1", "tt2", "tt10", "tt9"]);
  });

  it("filters to one type", () => {
    expect(ids(libraryItems(library, { type: "movie" }))).toEqual(["tt2", "tt10", "tt9"]);
  });

  it("sorts A–Z ignoring case, with numbers in order", () => {
    expect(ids(libraryItems(library, { sort: "name" }))).toEqual([
      "tt9",
      "tt10",
      "kitsu:1",
      "tt2",
      "tt3",
    ]);
  });

  it("sorts by last watched, then puts unwatched titles last, newest added first", () => {
    const lastWatched = { tt2: 100, tt9: 200 };
    expect(ids(libraryItems(library, { sort: "watched" }, lastWatched))).toEqual([
      "tt9",
      "tt2",
      "tt3",
      "kitsu:1",
      "tt10",
    ]);
  });

  it("leaves the store's list alone", () => {
    libraryItems(library, { sort: "name" });
    expect(library[0]?.contentId).toBe("tt3");
  });
});

describe("libraryTypes", () => {
  it("lists the library's types as Movies, Shows, Anime, then others by name", () => {
    expect(libraryTypes([...library, item("c1", "tv", "News", 0)])).toEqual([
      { type: "movie", label: "Movies" },
      { type: "series", label: "Shows" },
      { type: "anime", label: "Anime" },
      { type: "tv", label: "Tv" },
    ]);
  });
});

describe("librarySearch", () => {
  it("keeps a known sort and a type, and drops anything else", () => {
    expect(librarySearch({ type: "movie", sort: "name" })).toEqual({ type: "movie", sort: "name" });
    expect(librarySearch({ type: "", sort: "rating", page: 2 })).toEqual({});
  });

  it("keeps the Upcoming view (#48), and leaves the titles view out", () => {
    expect(librarySearch({ view: "upcoming", sort: "name" })).toEqual({
      sort: "name",
      view: "upcoming",
    });
    expect(librarySearch({ view: "titles" })).toEqual({});
  });

  it("keeps Upcoming's calendar layout, and drops any other", () => {
    expect(librarySearch({ view: "upcoming", layout: "calendar" })).toEqual({
      view: "upcoming",
      layout: "calendar",
    });
    expect(librarySearch({ view: "upcoming", layout: "grid" })).toEqual({ view: "upcoming" });
  });
});

describe("libraryMeta", () => {
  const show = { ...item("tt3", "series", "The Wire", 30), releaseInfo: "2002–2008" };

  it("is the year, then the episode a show in progress is on", () => {
    expect(libraryMeta(show)).toBe("2002–2008");
    expect(libraryMeta(show, "S2 · E5")).toBe("2002–2008 · S2 · E5");
  });

  it("has no line when there is nothing to say", () => {
    expect(libraryMeta({ ...show, releaseInfo: "" })).toBeUndefined();
    expect(libraryMeta({ ...show, releaseInfo: "" }, "S1 · E1")).toBe("S1 · E1");
  });
});

const entry = (contentId: string, season: number | null, episode: number | null): Progress => ({
  key: "",
  contentId,
  contentType: "series",
  videoId: contentId,
  season,
  episode,
  position: 0,
  duration: 1000,
  lastWatched: 1,
});

describe("episodeLabels", () => {
  it("labels the entries that are on an episode, by content ID", () => {
    const labels = episodeLabels([entry("tt3", 2, 5), entry("tt2", null, null)]);
    expect([...labels]).toEqual([["tt3", "S2 · E5"]]);
  });
});
