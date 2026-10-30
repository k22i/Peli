import { queryOptions, useQuery } from "@tanstack/react-query";

import { Service as SkipTimes, type Segment, type Title } from "@bindings/markers";
import type { Chapter, Watching } from "@bindings/player";
import { deviceSettingsQuery } from "@/lib/settings";

// Skip intro and credits (#69, F24): where a file's intro, recap and credits
// are, from its own chapters when their names say so, or else from IntroDB
// (internal/markers, Go), by the title's IMDb id. Chapters belong to the
// file; IntroDB's times are the community's, for one release of the title,
// so they're kept inside the file's length. While playback is in one, the
// player offers to skip it, and skips intros and recaps by itself when the
// profile says so. Times are in seconds.

export type { Segment };
export type SegmentKind = "intro" | "recap" | "credits";

// Chapter names, lowercased, with punctuation and a trailing number gone
// ("OP", "Opening 2", "Main Titles", "End Credits"). Whole names only: a
// chapter called "Opening Night" or "Credit Check" is part of the story.
const chapterKinds: [SegmentKind, RegExp][] = [
  [
    "intro",
    /^(intro|introduction|opening( credits| theme| song)?|op|title sequence|main titles?|theme song)$/,
  ],
  ["recap", /^(recap|previously( on.*)?)$/],
  ["credits", /^((end(ing)?|closing) (credits|titles|theme|song)|credits|ending|ed|outro)$/],
];

export function chapterKind(title: string): SegmentKind | undefined {
  const name = title
    .toLowerCase()
    .replaceAll(/[^\p{L}\p{N} ]+/gu, " ")
    .replace(/\s*\d+$/, "")
    .replaceAll(/\s+/g, " ")
    .trim();
  return chapterKinds.find(([, pattern]) => pattern.test(name))?.[0];
}

// The segments a file's chapters name: each from its start to the next
// chapter's, or the end of the file.
export function chapterSegments(chapters: readonly Chapter[], duration: number): Segment[] {
  const segments: Segment[] = [];
  chapters.forEach((chapter, index) => {
    const kind = chapterKind(chapter.title);
    const end = chapters[index + 1]?.time ?? duration;
    if (kind && end > chapter.time) segments.push({ kind, start: chapter.time, end });
  });
  return segments;
}

// Shorter than this isn't worth a button.
const shortest = 3;

// What there is to skip in a file of duration, in order: its chapters'
// segments, or IntroDB's when its chapters name none. IntroDB's past the end
// of the file are for another cut, and end with the file at most. Nothing
// until the length is known.
export function skipSegments(
  chapters: readonly Chapter[],
  online: readonly Segment[],
  duration: number,
): Segment[] {
  if (!(duration > 0)) return [];
  const own = chapterSegments(chapters, duration);
  const chosen = own.length > 0 ? own : online;
  // An intro or recap after the credits start is a mistake (IntroDB has
  // one for a film).
  const credits = Math.min(
    ...chosen.filter((segment) => segment.kind === "credits").map((segment) => segment.start),
  );
  return chosen
    .map(({ kind, start, end }) => ({ kind, start, end: Math.min(end, duration) }))
    .filter(
      (segment) =>
        segment.start >= 0 &&
        segment.end - segment.start >= shortest &&
        (segment.kind === "credits" || segment.start < credits),
    )
    .toSorted((a, b) => a.start - b.start);
}

// The segment position is in, if any: none in its last second, as a skip
// would land about there.
export function segmentAt(segments: readonly Segment[], position: number): Segment | undefined {
  return segments.find((segment) => position >= segment.start && position < segment.end - 1);
}

export const skipLabels: Record<string, string> = {
  intro: "Skip intro",
  recap: "Skip recap",
  credits: "Skip credits",
};

// What IntroDB knows a film or episode by, or none for ids that aren't
// IMDb's (Kitsu's anime).
export function skipTitle(watching: Watching | undefined): Title | undefined {
  if (!watching || !/^tt\d+$/.test(watching.contentId)) return undefined;
  if (watching.contentType === "movie")
    return { imdbId: watching.contentId, season: 0, episode: 0 };
  const { season, episode } = watching;
  if (typeof season !== "number" || typeof episode !== "number") return undefined;
  return { imdbId: watching.contentId, season, episode };
}

export const skipTimesQuery = (title: Title) =>
  queryOptions({
    queryKey: ["skip-times", title.imdbId, title.season, title.episode],
    queryFn: async () => (await SkipTimes.Segments(title)) ?? [],
    staleTime: 24 * 60 * 60 * 1000,
    retry: false,
  });

// IntroDB's segments for what's playing, while Settings allow asking it;
// none while it answers, or if it can't.
export function useOnlineSegments(watching: Watching | undefined): Segment[] {
  const title = skipTitle(watching);
  const online = useQuery(deviceSettingsQuery).data?.skipTimesOnline === true;
  const segments = useQuery({
    ...skipTimesQuery(title ?? { imdbId: "", season: 0, episode: 0 }),
    enabled: title !== undefined && online,
  }).data;
  return title && online && segments ? segments : none;
}

const none: Segment[] = [];
