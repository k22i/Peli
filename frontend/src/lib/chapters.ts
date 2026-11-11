import type { PlayerState } from "@/lib/player";

// The file's chapters (Go's State.chapters, mpv's chapter-list): the More
// menu lists them, Page Up and Page Down go to the one before and after.

export type Chapter = NonNullable<PlayerState["chapters"]>[number];

// Back this soon after a chapter starts goes to the one before it, as a
// track's back button does; later, to its own start.
const backWithin = 3;

// The index of the chapter playing at position, -1 before the first.
export function chapterAt(chapters: readonly Chapter[], position: number): number {
  return chapters.findLastIndex((chapter) => chapter.time <= position + 0.25);
}

// Where Page Up goes: this chapter's start, or the one before's when it
// has only just started. undefined without chapters.
export function previousChapter(
  chapters: readonly Chapter[],
  position: number,
): { index: number; chapter: Chapter } | undefined {
  const at = chapterAt(chapters, position);
  if (at < 0) return chapters.length > 0 ? { index: 0, chapter: chapters[0]! } : undefined;
  const index = position - chapters[at]!.time < backWithin && at > 0 ? at - 1 : at;
  return { index, chapter: chapters[index]! };
}

// Where Page Down goes: the next chapter's start, undefined in the last.
export function nextChapter(
  chapters: readonly Chapter[],
  position: number,
): { index: number; chapter: Chapter } | undefined {
  const index = chapterAt(chapters, position) + 1;
  const chapter = chapters[index];
  return chapter ? { index, chapter } : undefined;
}

// "Opening Credits", or "Chapter 3" for one without a name.
export function chapterName(chapter: Chapter, index: number): string {
  return chapter.title.trim() || `Chapter ${index + 1}`;
}
