import { describe, expect, it } from "vite-plus/test";

import type { LibraryItem } from "@bindings/store";
import type { Meta, Video } from "@/lib/addon-protocol";
import {
  airTime,
  calendar,
  calendarShows,
  dayKey,
  dayLabel,
  entryCode,
  type CalendarShow,
} from "@/lib/calendar";

// Local times, since days are the viewer's: Friday 30 October 2026, noon.
const at = (month: number, date: number, hours = 12, year = 2026) =>
  new Date(year, month - 1, date, hours).getTime();
const now = at(10, 30);
const iso = (time: number) => new Date(time).toISOString();

const item = (contentId: string, contentType: string, name: string) =>
  ({ contentId, contentType, name, addedAt: 1 }) as LibraryItem;

const video = (season: number, episode: number, released?: number | string): Video => ({
  id: `${season}:${episode}`,
  title: `Episode ${season}.${episode}`,
  season,
  episode,
  ...(released === undefined
    ? {}
    : { released: typeof released === "number" ? iso(released) : released }),
});

const show = (name: string, videos: Video[]): CalendarShow => {
  const id = name.toLowerCase();
  const meta: Meta = { id, type: "series", name, videos };
  return { item: item(id, "series", name), meta };
};

const names = (entries: { item: LibraryItem; episode: { season: number; episode: number } }[]) =>
  entries.map((entry) => `${entry.item.name} ${entry.episode.season}.${entry.episode.episode}`);

describe("calendarShows", () => {
  it("keeps everything but films", () => {
    const library = [
      item("tt1", "series", "Show"),
      item("tt2", "movie", "Film"),
      item("kitsu:1", "anime", "Anime"),
      item("ch", "channel", "Channel"),
    ];
    expect(calendarShows(library).map((entry) => entry.name)).toEqual(["Show", "Anime", "Channel"]);
  });
});

describe("calendar", () => {
  it("lists episodes from the start of today by day, in time order", () => {
    const { days, later } = calendar(
      [
        show("Severance", [
          video(2, 1, at(10, 29)),
          video(2, 2, at(10, 30, 1)),
          video(2, 3, at(11, 6)),
        ]),
        show("Andor", [video(1, 1, at(10, 30, 1)), video(1, 2, at(10, 31, 9))]),
      ],
      now,
    );
    expect(days.map((day) => [day.day, names(day.entries)])).toEqual([
      // The same time: by name.
      ["2026-10-30", ["Andor 1.1", "Severance 2.2"]],
      ["2026-10-31", ["Andor 1.2"]],
      ["2026-11-06", ["Severance 2.3"]],
    ]);
    expect(later).toEqual([]);
  });

  it("leaves out Specials and episodes with no date or a broken one", () => {
    const { days } = calendar(
      [
        show("Show", [
          video(0, 1, at(11, 1)),
          video(1, 1),
          video(1, 2, "soon"),
          video(1, 3, at(11, 2)),
        ]),
      ],
      now,
    );
    expect(days.flatMap((day) => names(day.entries))).toEqual(["Show 1.3"]);
  });

  it("puts only each show's next episode past four weeks in Later, soonest first", () => {
    const { days, later } = calendar(
      [
        show("Far", [video(3, 2, at(3, 9, 12, 2027)), video(3, 1, at(3, 2, 12, 2027))]),
        show("Near", [video(1, 1, at(11, 26)), video(1, 2, at(12, 3))]),
        show("Soon", [video(1, 1, at(11, 2)), video(1, 2, at(12, 30))]),
      ],
      now,
    );
    expect(days.flatMap((day) => names(day.entries))).toEqual(["Soon 1.1", "Near 1.1"]);
    // Soon is already on the calendar, so it isn't repeated.
    expect(names(later)).toEqual(["Far 3.1"]);
  });
});

describe("a show's episodes on one day", () => {
  it("share one entry, coded as a run", () => {
    const { days } = calendar(
      [
        show("Drop", [video(3, 1, at(11, 11)), video(3, 2, at(11, 11)), video(3, 3, at(11, 11))]),
        show("Mixed", [video(1, 9, at(11, 11, 9)), video(2, 1, at(11, 11, 10))]),
      ],
      now,
    );
    const [day] = days;
    // Mixed's first episode airs first.
    expect(day?.entries.map(entryCode)).toEqual(["S1 · E9 +1", "S3 · E1–E3"]);
    expect(day?.entries[1]?.episodes).toHaveLength(3);
  });
});

describe("dayLabel", () => {
  it("names the days of this week and dates the rest", () => {
    expect(dayLabel(dayKey(now), now)).toEqual({ title: "Today", date: expect.any(String) });
    expect(dayLabel(dayKey(at(10, 31)), now).title).toBe("Tomorrow");
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
    expect(dayLabel(dayKey(at(11, 5)), now).title).toBe(weekday.format(at(11, 5)));
    const later = dayLabel(dayKey(at(11, 6)), now);
    expect(later.date).toBeUndefined();
    expect(later.title).toContain(weekday.format(at(11, 6)));
    expect(later.title).not.toContain("2026");
    expect(dayLabel(dayKey(at(1, 4, 12, 2027)), now).title).toContain("2027");
  });
});

const first = (released: number | string) =>
  calendar([show("Dune", [video(1, 1, released)])], now).days[0]?.entries[0];

describe("airTime", () => {
  it("is the time an episode airs, in the viewer's zone", () => {
    const entry = first(at(10, 31, 21));
    expect(entry && airTime(entry)).toBe(
      new Intl.DateTimeFormat(undefined, { timeStyle: "short" }).format(at(10, 31, 21)),
    );
  });

  it("is nothing for a date, which an addon gives as midnight UTC", () => {
    const entry = first("2026-11-02");
    expect(entry).toBeDefined();
    expect(entry && airTime(entry)).toBeUndefined();
    const stamped = first("2026-11-02T00:00:00.000Z");
    expect(stamped && airTime(stamped)).toBeUndefined();
  });
});
