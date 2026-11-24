import type { LibraryItem } from "@bindings/store";
import type { Meta } from "@/lib/addon-protocol";
import { episodeCode, episodes, type Episode } from "@/lib/title";

// The library's upcoming episodes (#48), on the Library page's Upcoming
// view: every episode of a saved show that airs from today on, by day, for
// the next four weeks, then each show's next episode after that (ADR-0032).

// How far ahead the calendar lists every episode, in days. Past it, only
// each show's next one shows, so a show that lists a whole season ahead
// doesn't fill the page.
export const calendarDays = 28;
const msPerDay = 86_400_000;

// The library titles that can have episodes: anything that isn't a film.
// Kitsu types its anime "series" or "movie", and channels list videos
// without seasons, which `episodes` leaves out.
export const calendarShows = (library: readonly LibraryItem[]) =>
  library.filter((item) => item.contentType !== "movie");

// A show from the library with its details from an addon.
export type CalendarShow = { item: LibraryItem; meta: Meta };

// One show's episodes on one day: usually one, or several when a show
// releases them together. `episode` is the first.
export type CalendarEntry = CalendarShow & { episode: Episode; episodes: Episode[]; airs: number };

export type CalendarDay = { day: string; entries: CalendarEntry[] };

export type Calendar = {
  // Day by day, from today, for `calendarDays` days.
  days: CalendarDay[];
  // Each show's next episode after that, soonest first.
  later: CalendarEntry[];
};

// A local date as "2026-10-30", which sorts as it reads. Air dates show as
// the title page shows them, in the viewer's time zone.
const pad = (value: number) => String(value).padStart(2, "0");

export function dayKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

// A local month as "2026-11", for the calendar layout's month grid. It sorts
// as it reads too, so grids can be compared without parsing them.
export function monthKey(time: number): string {
  const date = new Date(time);
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}`;
}

// A month key moved by whole months, either way over a year's end: the grid's
// previous and next arrows. Day 1 of the shifted month, so no short month
// can push the date into its neighbour.
export function shiftMonth(month: string, by: number): string {
  const [year = 1970, monthNumber = 1] = month.split("-").map(Number);
  return monthKey(new Date(year, monthNumber - 1 + by, 1).getTime());
}

// Midnight local time, `days` days after `time`'s day.
function startOfDay(time: number, days = 0): number {
  const date = new Date(time);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days).getTime();
}

// Episodes from today on, Specials left out (they're extras and recaps, and
// Nuvio's apps don't count them either), each show's in episode order. An
// episode with no date, or one that can't be read, isn't scheduled.
export function calendar(shows: readonly CalendarShow[], now = Date.now()): Calendar {
  const from = startOfDay(now);
  const until = startOfDay(now, calendarDays);
  const soon: CalendarEntry[] = [];
  const later: CalendarEntry[] = [];
  for (const show of shows) {
    let next: CalendarEntry | undefined;
    for (const episode of episodes(show.meta)) {
      const airs = episode.released === undefined ? Number.NaN : Date.parse(episode.released);
      if (episode.season === 0 || Number.isNaN(airs) || airs < from) continue;
      const entry = { ...show, episode, episodes: [episode], airs };
      if (airs < until) soon.push(entry);
      else if (!next || airs < next.airs) next = entry;
    }
    // A show already on the calendar this month isn't repeated in Later.
    if (next && !soon.some((entry) => entry.item === show.item)) later.push(next);
  }
  return {
    days: [...groupByDay(soon)].map(([day, entries]) => ({ day, entries })),
    later: later.toSorted(byTime),
  };
}

// A day's order: by air time, then by show name.
const byTime = (a: CalendarEntry, b: CalendarEntry) =>
  a.airs - b.airs || collator.compare(a.item.name, b.item.name);

// Entries gathered by the day they air on, in the order their first entry
// airs, each day in time order. A show's episodes on one day share one entry,
// since an addon gives a binge drop a single date; pushing onto its `episodes`
// only ever touches the copy made per episode, never the caller's show.
function groupByDay(entries: readonly CalendarEntry[]): Map<string, CalendarEntry[]> {
  const days = new Map<string, CalendarEntry[]>();
  for (const entry of entries.toSorted(byTime)) {
    const day = dayKey(entry.airs);
    const dayEntries = days.get(day) ?? [];
    const same = dayEntries.find((other) => other.item === entry.item);
    if (same) same.episodes.push(entry.episode);
    else days.set(day, [...dayEntries, entry]);
  }
  return days;
}

// Every episode of the shows that airs from `from` to `until` (day keys, both
// inclusive), past ones included: the calendar layout's month. Specials are
// left out and undated or unreadable dates are skipped, as in `calendar`, and
// a show's episodes on one day share an entry there too. Days with nothing
// aren't in the map.
export function scheduleByDay(
  shows: readonly CalendarShow[],
  from: string,
  until: string,
): Map<string, CalendarEntry[]> {
  const airing: CalendarEntry[] = [];
  for (const show of shows) {
    for (const episode of episodes(show.meta)) {
      const airs = episode.released === undefined ? Number.NaN : Date.parse(episode.released);
      if (episode.season === 0 || Number.isNaN(airs)) continue;
      const day = dayKey(airs);
      // Day keys sort as they read, so the range is a plain string compare.
      if (day < from || day > until) continue;
      airing.push({ ...show, episode, episodes: [episode], airs });
    }
  }
  return groupByDay(airing);
}

// How far back Home's New episodes row looks, in days.
export const newEpisodeDays = 7;

// Each show's latest episode that has aired in the last week, newest first:
// Home's New episodes row. Specials are left out, as in `calendar`. Several
// episodes of a show released together show as the latest one with the rest
// in `episodes`, so a binge drop is one card.
export function recentEpisodes(shows: readonly CalendarShow[], now = Date.now()): CalendarEntry[] {
  const from = now - newEpisodeDays * msPerDay;
  const out: CalendarEntry[] = [];
  for (const show of shows) {
    let latest: CalendarEntry | undefined;
    for (const episode of episodes(show.meta)) {
      const airs = episode.released === undefined ? Number.NaN : Date.parse(episode.released);
      if (episode.season === 0 || Number.isNaN(airs) || airs > now || airs <= from) continue;
      if (!latest || airs > latest.airs) latest = { ...show, episode, episodes: [episode], airs };
      else if (airs === latest.airs) latest.episodes.push(episode);
    }
    if (latest) out.push(latest);
  }
  return out.toSorted((a, b) => b.airs - a.airs || collator.compare(a.item.name, b.item.name));
}

const collator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

const weekday = new Intl.DateTimeFormat(undefined, { weekday: "long" });
const dayMonth = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short" });
const thisYear = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  day: "numeric",
  month: "long",
});
const otherYear = new Intl.DateTimeFormat(undefined, { dateStyle: "long" });

// A day's heading: Today, Tomorrow or the weekday within the week, with the
// date beside it ("30 Oct"); any other day the date itself ("Monday 16
// November"), with the year when it isn't this one. A day before today takes
// that date too, since a bare weekday would read as this week's.
export function dayLabel(day: string, now = Date.now()): { title: string; date?: string } {
  const [year = 0, month = 1, date = 1] = day.split("-").map(Number);
  const time = new Date(year, month - 1, date).getTime();
  const near = (title: string) => ({ title, date: dayMonth.format(time) });
  if (day === dayKey(now)) return near("Today");
  if (day === dayKey(startOfDay(now, 1))) return near("Tomorrow");
  if (time > startOfDay(now) && time < startOfDay(now, 7)) return near(weekday.format(time));
  return { title: (year === new Date(now).getFullYear() ? thisYear : otherYear).format(time) };
}

// A day in the month grid, with what the grid needs to style it without
// looking the day up again: today's cell stands out, and past days don't.
export type MonthCell = {
  day: string;
  inMonth: boolean;
  today: boolean;
  past: boolean;
};

// `Intl.Locale`'s week info is newer than the ES2023 types, and older
// runtimes expose it as a `weekInfo` property rather than a method, so read
// both through a small local shape.
type WeekInfo = { firstDay?: number | undefined };
type LocaleWeekInfo = Intl.Locale & {
  getWeekInfo?: () => WeekInfo | undefined;
  weekInfo?: WeekInfo | undefined;
};

// The day a week starts on where the viewer is: 0 for Sunday to 6 for
// Saturday. Their locale decides it (en-US starts on Sunday, en-GB on
// Monday). Monday is the guess when it can't be read, since most of the world
// starts there and Node may have no week info at all.
export function firstWeekday(locale?: string): number {
  try {
    const language = locale ?? (typeof navigator === "undefined" ? undefined : navigator.language);
    if (language) {
      const extended: LocaleWeekInfo = new Intl.Locale(language);
      const firstDay = (extended.getWeekInfo?.() ?? extended.weekInfo)?.firstDay;
      // Intl counts 1 to 7 from Monday, with 7 for Sunday.
      if (typeof firstDay === "number" && firstDay >= 1 && firstDay <= 7) return firstDay % 7;
    }
  } catch {
    // A locale tag that won't parse, or a runtime with no week info.
  }
  return 1;
}

// The month as whole weeks, 4 to 6 of them, from the week holding the 1st to
// the week holding the last day, so every row lines up under `weekdayNames`.
// Both weeks `weekStart` says, and the neighbouring months' days come along to
// fill them.
export function monthGrid(month: string, now = Date.now(), weekStart = 1): MonthCell[][] {
  const [year = 1970, monthNumber = 1] = month.split("-").map(Number);
  const monthIndex = monthNumber - 1;
  const first = new Date(year, monthIndex, 1);
  // Day 0 of the next month is this month's last day, so leap years need no
  // table of their own.
  const last = new Date(year, monthIndex + 1, 0);
  // How many days of the month before fill the first week.
  const lead = (first.getDay() - weekStart + 7) % 7;
  const weekCount = Math.ceil((lead + last.getDate()) / 7);
  const today = dayKey(now);
  const weeks: MonthCell[][] = [];
  for (let week = 0; week < weekCount; week += 1) {
    const cells: MonthCell[] = [];
    for (let index = 0; index < 7; index += 1) {
      // Counted from the 1st, so Date rolls into the neighbouring months
      // itself: no day is reached by adding milliseconds across a DST change.
      const date = new Date(year, monthIndex, 1 - lead + week * 7 + index);
      const day = dayKey(date.getTime());
      const inMonth = date.getFullYear() === year && date.getMonth() === monthIndex;
      cells.push({ day, inMonth, today: day === today, past: day < today });
    }
    weeks.push(cells);
  }
  return weeks;
}

const weekdayFormats: Record<"short" | "narrow", Intl.DateTimeFormat> = {
  short: new Intl.DateTimeFormat(undefined, { weekday: "short" }),
  narrow: new Intl.DateTimeFormat(undefined, { weekday: "narrow" }),
};

// The grid's weekday headings, in its order: "Mon", "Tue", … or "M", "T", ….
// Formatted from a real week, since Intl needs a date, and from a fixed one
// (Monday 23 November 2026) so the names never depend on today.
export function weekdayNames(weekStart: number, width: "short" | "narrow"): string[] {
  const format = weekdayFormats[width];
  return Array.from({ length: 7 }, (_, index) => {
    // Weekday 2 (Tuesday) is the day after that Monday, and 0 (Sunday) is the
    // last day of the week that starts on it.
    const weekday = (weekStart + index) % 7;
    const date = new Date(2026, 10, 23 + (weekday === 0 ? 6 : weekday - 1));
    return format.format(date);
  });
}

const monthName = new Intl.DateTimeFormat(undefined, { month: "long" });

// The grid's heading: "November", or "November 2027" when it isn't this year,
// as `dayLabel` dates the days it can't name.
export function monthLabel(month: string, now = Date.now()): string {
  const [year = 1970, monthNumber = 1] = month.split("-").map(Number);
  const name = monthName.format(new Date(year, monthNumber - 1, 1));
  return year === new Date(now).getFullYear() ? name : `${name} ${year}`;
}

// An entry's episodes: "S3 · E1–E4" for a run in one season, otherwise the
// first one's code and how many more.
export function entryCode(entry: CalendarEntry): string {
  const list = entry.episodes;
  const [first] = list;
  const last = list.at(-1);
  if (!first || !last || first === last) return first ? episodeCode(first) : "";
  const run =
    list.every((e) => e.season === first.season) &&
    last.episode - first.episode === list.length - 1;
  return run
    ? `S${first.season} · E${first.episode}–E${last.episode}`
    : `${episodeCode(first)} +${list.length - 1}`;
}

const short = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });

// When a Later episode airs: "16 Jan 2027".
export const airDate = (time: number) => short.format(time);

const clock = new Intl.DateTimeFormat(undefined, { timeStyle: "short" });

// When an entry's first episode airs that day, in the viewer's time zone
// ("9:00 PM"). Addons mostly give a date, which parses as midnight UTC and is
// no time at all, so those have none.
export const airTime = (entry: CalendarEntry): string | undefined =>
  entry.airs % msPerDay === 0 ? undefined : clock.format(entry.airs);
