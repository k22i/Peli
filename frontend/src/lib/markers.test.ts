import { describe, expect, it } from "vite-plus/test";

import { chapterKind, chapterSegments, segmentAt, skipSegments, skipTitle } from "@/lib/markers";

const chapter = (title: string, time: number) => ({ title, time });
const kinds = (titles: string[]) => titles.map((title) => chapterKind(title));

describe("chapterKind", () => {
  it("knows intros, recaps and credits by their whole names", () => {
    const intros = ["Intro", "OP", "Opening", "Opening Credits", "Main Title", "OP2"];
    expect(kinds(intros)).toEqual(intros.map(() => "intro"));
    expect(kinds(["Recap", "Previously on…"])).toEqual(["recap", "recap"]);
    const credits = ["Credits", "End Credits", "ED", "Ending 2", "Outro", "Closing Titles"];
    expect(kinds(credits)).toEqual(credits.map(() => "credits"));
  });

  it("leaves story chapters alone", () => {
    const story = ["Opening Night", "Credit Check", "Chapter 1", "Prologue", "Part A", ""];
    expect(kinds(story)).toEqual(story.map(() => undefined));
  });
});

describe("chapterSegments", () => {
  it("runs each to the next chapter, the last to the end", () => {
    const chapters = [
      chapter("Prologue", 0),
      chapter("Opening", 90),
      chapter("Part A", 180),
      chapter("Ending", 1300),
    ];
    expect(chapterSegments(chapters, 1420)).toEqual([
      { kind: "intro", start: 90, end: 180 },
      { kind: "credits", start: 1300, end: 1420 },
    ]);
  });
});

describe("skipSegments", () => {
  const online = [
    { kind: "intro", start: 216, end: 232 },
    { kind: "credits", start: 2770, end: 2828 },
  ];

  it("takes the file's chapters over IntroDB's times", () => {
    const chapters = [chapter("Episode", 0), chapter("Intro", 60), chapter("Part 1", 120)];
    expect(skipSegments(chapters, online, 2800)).toEqual([{ kind: "intro", start: 60, end: 120 }]);
  });

  it("keeps IntroDB's times inside the file", () => {
    expect(skipSegments([chapter("Chapter 1", 0)], online, 2800)).toEqual([
      { kind: "intro", start: 216, end: 232 },
      { kind: "credits", start: 2770, end: 2800 },
    ]);
    // A shorter cut: its credits aren't where IntroDB says.
    expect(skipSegments([], online, 2000)).toEqual([{ kind: "intro", start: 216, end: 232 }]);
  });

  it("drops an intro after the credits", () => {
    const film = [
      { kind: "intro", start: 7512, end: 7545 },
      { kind: "credits", start: 7038, end: 7540 },
    ];
    expect(skipSegments([], film, 7580)).toEqual([{ kind: "credits", start: 7038, end: 7540 }]);
  });

  it("has nothing until the length is known", () => {
    expect(skipSegments([], online, 0)).toEqual([]);
  });
});

describe("segmentAt", () => {
  const segments = [{ kind: "intro", start: 60, end: 120 }];

  it("finds the segment playing, but not in its last second", () => {
    expect(segmentAt(segments, 59)).toBeUndefined();
    expect(segmentAt(segments, 60)).toBe(segments[0]);
    expect(segmentAt(segments, 118.9)).toBe(segments[0]);
    expect(segmentAt(segments, 119.5)).toBeUndefined();
  });
});

describe("skipTitle", () => {
  const watching = { profileId: 1, contentType: "series", contentId: "tt0903747" };

  it("names episodes and films by IMDb id", () => {
    expect(skipTitle({ ...watching, videoId: "tt0903747:2:3", season: 2, episode: 3 })).toEqual({
      imdbId: "tt0903747",
      season: 2,
      episode: 3,
    });
    expect(
      skipTitle({
        profileId: 1,
        contentType: "movie",
        contentId: "tt0371746",
        videoId: "tt0371746",
      }),
    ).toEqual({ imdbId: "tt0371746", season: 0, episode: 0 });
  });

  it("names nothing IntroDB can't know", () => {
    expect(
      skipTitle({ ...watching, contentId: "kitsu:7442", videoId: "kitsu:7442:1", episode: 1 }),
    ).toBeUndefined();
    expect(skipTitle({ ...watching, videoId: "tt0903747" })).toBeUndefined();
    expect(skipTitle(undefined)).toBeUndefined();
  });
});
