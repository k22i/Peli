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
  firstWeekday,
  monthGrid,
  monthKey,
  monthLabel,
  recentDayLabel,
  scheduleByDay,
  shiftMonth,
  weekdayNames,
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

  it("dates a day before today instead of naming its weekday", () => {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
    // Yesterday, and a Monday two weeks back: "Monday" alone would read as
    // this week's.
    for (const past of [at(10, 29), at(10, 19)]) {
      const label = dayLabel(dayKey(past), now);
      expect(label.date).toBeUndefined();
      expect(label.title).not.toBe(weekday.format(past));
      expect(label.title).toContain(weekday.format(past));
    }
  });
});

describe("recentDayLabel", () => {
  it("names today and yesterday, else the weekday, for a card caption", () => {
    const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
    expect(recentDayLabel(now, now)).toBe("Today");
    expect(recentDayLabel(at(10, 29), now)).toBe("Yesterday");
    expect(recentDayLabel(at(10, 27), now)).toBe(weekday.format(at(10, 27)));
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

// The calendar layout's month grid, as looked at on Tuesday 24 November 2026.
const november = at(11, 24);

describe("monthKey", () => {
  it("is the local month of a time", () => {
    expect(monthKey(november)).toBe("2026-11");
    expect(monthKey(at(1, 4, 12, 2027))).toBe("2027-01");
  });
});

describe("shiftMonth", () => {
  it("moves by whole months, over year ends both ways", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -1)).toBe("2025-12");
    expect(shiftMonth("2026-11", 0)).toBe("2026-11");
    expect(shiftMonth("2026-03", -3)).toBe("2025-12");
    expect(shiftMonth("2026-11", 14)).toBe("2028-01");
    expect(shiftMonth("2026-11", -11)).toBe("2025-12");
  });
});

describe("monthGrid", () => {
  const grid = monthGrid("2026-11", november, 1);
  const cells = grid.flat();
  const cell = (day: string) => cells.find((each) => each.day === day);

  it("is whole weeks, from the week holding the 1st to the one holding the last day", () => {
    expect(grid.length).toBeGreaterThanOrEqual(4);
    expect(grid.length).toBeLessThanOrEqual(6);
    expect(grid.every((week) => week.length === 7)).toBe(true);
    // 1 November 2026 is a Sunday, so a Monday grid opens on 26 October.
    expect(grid[0]?.[0]).toEqual({ day: "2026-10-26", inMonth: false, today: false, past: true });
    expect(grid.at(-1)?.map((each) => each.day)).toContain("2026-11-30");
  });

  it("opens on 1 November when the viewer's week starts on Sunday", () => {
    expect(monthGrid("2026-11", november, 0)[0]?.[0]?.day).toBe("2026-11-01");
  });

  it("marks today, and the days before it, and nothing after", () => {
    expect(cells.filter((each) => each.today).map((each) => each.day)).toEqual(["2026-11-24"]);
    expect(cell("2026-11-23")?.past).toBe(true);
    expect(cell("2026-11-24")?.past).toBe(false);
    expect(cell("2026-11-25")?.past).toBe(false);
  });

  it("keeps the neighbouring months' days, out of the month", () => {
    expect(cell("2026-11-01")?.inMonth).toBe(true);
    expect(cell("2026-10-26")?.inMonth).toBe(false);
    expect(cell("2026-12-06")?.inMonth).toBe(false);
  });
});

describe("firstWeekday", () => {
  it("falls back to Monday for a locale it can't read", () => {
    const weekday = firstWeekday("xx-invalid-@@");
    expect(typeof weekday).toBe("number");
    expect(weekday).toBeGreaterThanOrEqual(0);
    expect(weekday).toBeLessThanOrEqual(6);
  });

  it("answers 0 to 6 for a real locale, or with none given", () => {
    expect([0, 1, 2, 3, 4, 5, 6]).toContain(firstWeekday("en-GB"));
    expect([0, 1, 2, 3, 4, 5, 6]).toContain(firstWeekday());
  });
});

describe("weekdayNames", () => {
  it("names seven days in grid order, from the first day of the week", () => {
    const headings = weekdayNames(1, "short");
    expect(headings).toHaveLength(7);
    const short = new Intl.DateTimeFormat(undefined, { weekday: "short" });
    // Monday 23 November 2026, the week those headings come from.
    expect(headings[0]).toBe(short.format(new Date(2026, 10, 23)));
  });

  it("has a narrow form", () => {
    expect(weekdayNames(0, "narrow")).toHaveLength(7);
    expect(weekdayNames(0, "narrow").every((name) => name.length >= 1)).toBe(true);
  });
});

describe("monthLabel", () => {
  const long = new Intl.DateTimeFormat(undefined, { month: "long" });

  it("names this year's month without the year", () => {
    expect(monthLabel("2026-11", november)).toBe(long.format(new Date(2026, 10, 1)));
  });

  it("adds the year when it isn't this one", () => {
    expect(monthLabel("2027-01", november)).toContain("2027");
    expect(monthLabel("2027-01", november)).toContain(long.format(new Date(2027, 0, 1)));
  });
});

describe("scheduleByDay", () => {
  const shows = [
    show("Severance", [
      video(2, 1, at(11, 23)),
      video(0, 1, at(11, 25)),
      video(2, 2, at(12, 8)),
      video(2, 3, at(11, 26)),
      video(2, 4, at(11, 26)),
    ]),
    show("Andor", [video(1, 1, at(11, 25))]),
  ];
  const days = scheduleByDay(shows, "2026-11-20", "2026-11-30");

  it("maps every day of the range that has an episode, past ones included", () => {
    expect([...days.keys()]).toEqual(["2026-11-23", "2026-11-25", "2026-11-26"]);
    // Two days before today, and still in.
    expect(names(days.get("2026-11-23") ?? [])).toEqual(["Severance 2.1"]);
  });

  it("leaves out Specials and the days outside the range", () => {
    // Only Andor's episode is left on the 25th.
    expect(names(days.get("2026-11-25") ?? [])).toEqual(["Andor 1.1"]);
    expect(days.get("2026-12-08")).toBeUndefined();
  });

  it("merges a show's episodes on one day into one entry", () => {
    const [entry] = days.get("2026-11-26") ?? [];
    expect(entry?.episodes).toHaveLength(2);
    expect(entry && entryCode(entry)).toBe("S2 · E3–E4");
  });

  it("takes both ends of the range", () => {
    const edges = [show("Edge", [video(1, 1, at(11, 20)), video(1, 2, at(11, 30))])];
    expect([...scheduleByDay(edges, "2026-11-20", "2026-11-30").keys()]).toEqual([
      "2026-11-20",
      "2026-11-30",
    ]);
  });
});
