import { describe, expect, it } from "vite-plus/test";

import { chapterAt, chapterName, nextChapter, previousChapter } from "@/lib/chapters";

const chapters = [
  { title: "Intro", time: 0 },
  { title: "", time: 90 },
  { title: "Credits", time: 1200 },
];

describe("chapterAt", () => {
  it("finds the chapter playing", () => {
    expect(chapterAt(chapters, 0)).toBe(0);
    expect(chapterAt(chapters, 89)).toBe(0);
    expect(chapterAt(chapters, 90)).toBe(1);
    // A seek lands a hair before the start.
    expect(chapterAt(chapters, 89.9)).toBe(1);
    expect(chapterAt(chapters, 5000)).toBe(2);
    expect(chapterAt([], 10)).toBe(-1);
  });
});

describe("previousChapter", () => {
  it("goes to this chapter's start, or the one before just after a start", () => {
    expect(previousChapter(chapters, 300)?.index).toBe(1);
    expect(previousChapter(chapters, 91)?.index).toBe(0);
    expect(previousChapter(chapters, 1)?.index).toBe(0);
    expect(previousChapter([], 10)).toBeUndefined();
  });

  it("goes to the first chapter from before it", () => {
    expect(previousChapter([{ title: "", time: 30 }], 10)?.index).toBe(0);
  });
});

describe("nextChapter", () => {
  it("goes to the next chapter, none from the last", () => {
    expect(nextChapter(chapters, 10)?.chapter.time).toBe(90);
    expect(nextChapter(chapters, 1300)).toBeUndefined();
    expect(nextChapter([], 10)).toBeUndefined();
  });
});

describe("chapterName", () => {
  it("numbers a chapter without a name", () => {
    expect(chapterName(chapters[0]!, 0)).toBe("Intro");
    expect(chapterName(chapters[1]!, 1)).toBe("Chapter 2");
  });
});
